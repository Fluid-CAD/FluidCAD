import { describe, it, expect } from "vitest";
import type { TopAbs_ShapeEnum } from "ocjs-fluidcad";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import chamfer from "../../core/chamfer.js";
import fillet from "../../core/fillet.js";
import repeat from "../../core/repeat.js";
import { testRect } from "../helpers/profiles.js";
import { SceneObject } from "../../common/scene-object.js";
import { Shape } from "../../common/shape.js";
import { Face } from "../../common/face.js";
import { Edge } from "../../common/edge.js";
import { Scene } from "../../rendering/scene.js";
import { getOC } from "../../oc/init.js";
import { FaceOps } from "../../oc/face-ops.js";
import { ShapeProps } from "../../oc/props.js";
import { BooleanOps } from "../../oc/boolean-ops.js";
import { CutToolImages } from "../../oc/cut-tool-images.js";
import { Primitives } from "../../oc/primitives.js";
import type { ISelection } from "../../sdk/index.js";
import { ShapeOps } from "../../sdk/kernel.js";
import { Matrix4, Point, Vector3d } from "../../math/index.js";
import { definePlainPocket, pocket, POCKET_DEFAULTS, type PocketFeature } from "../fixtures/custom-features/pocket.js";

/** The plates stand 10 thick on XY: their top faces are at z = 10. */
const PLATE_TOP = 10;
/** The default pocket's floor. */
const FLOOR = PLATE_TOP - POCKET_DEFAULTS.depth;
/** The default pocket's outline: a 30 × 20 rectangle with corners of radius 4. */
const FLOOR_AREA = POCKET_DEFAULTS.length * POCKET_DEFAULTS.width - (4 - Math.PI) * POCKET_DEFAULTS.radius ** 2;
const PLATE_VOLUME = 80 * 80 * PLATE_TOP;

/** The buckets a remove's cut classifies, whatever the tool names. */
const STANDARD_KEYS = ['start-edges', 'end-edges', 'internal-edges', 'section-edges', 'internal-faces'];

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap(o => o.getError() ? [`${o.getUniqueType()}: ${o.getError()}`] : []);
}

/** A lazy accessor's shapes — built here the way a consuming statement would build it. */
function resolved(selection: ISelection): Shape[] {
  const lazy = selection as unknown as SceneObject;
  lazy.build();
  return lazy.getShapes();
}

/** A `size` × `size` × 10 plate on XY whose top face is centred on (`cx`, 0). */
function plate(cx = 0, size = 80): SceneObject & { endFaces(): ISelection } {
  sketch("xy", () => {
    testRect(size, size, { at: [cx - size / 2, -size / 2] });
  });
  return extrude(PLATE_TOP) as unknown as SceneObject & { endFaces(): ISelection };
}

function solidsOf(obj: SceneObject): Shape[] {
  return obj.getShapes().filter(s => s.isSolid());
}

/** Whether every one of `members` is one of `shapes` or a face or an edge of one. */
function allIn(members: Shape[], shapes: Shape[]): boolean {
  const oc = getOC();
  const held = new oc.TopTools_IndexedMapOfShape();
  try {
    for (const shape of shapes) {
      oc.TopExp.MapShapes(shape.getShape(), oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum, held);
      oc.TopExp.MapShapes(shape.getShape(), oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum, held);
    }
    return members.every(member => held.FindIndex(member.getShape()) > 0);
  } finally {
    held.delete();
  }
}

/** Whether `a` and `b` hold the same shapes (by `IsSame`), whatever their order. */
function sameShapes(a: Shape[], b: Shape[]): boolean {
  return a.length === b.length && allIn(a, b) && allIn(b, a);
}

/** A shape's exact bounds, rounded off: `[minX, minY, minZ, maxX, maxY, maxZ]`. */
function bounds(shape: Shape): number[] {
  const b = ShapeOps.getExactBoundingBox(shape);
  return [b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ].map(v => Math.round(v * 1e4) / 1e4 + 0);
}

function area(face: Shape): number {
  return ShapeProps.getProperties(face.getShape()).surfaceAreaMm2;
}

function volumeOf(scene: Scene): number {
  return scene.getSceneObjects()
    .filter(o => !o.isContainer())
    .flatMap(o => o.getShapes())
    .filter(s => s.isSolid())
    .reduce((sum, s) => sum + ShapeProps.getProperties(s.getShape()).volumeMm3, 0);
}

/** A face's centre of mass. */
function centroid(f: Shape): Point {
  const oc = getOC();
  const props = new oc.GProp_GProps();
  oc.BRepGProp.SurfaceProperties(f.getShape(), props, false, false);
  const c = props.CentreOfMass();
  const point = new Point(c.X(), c.Y(), c.Z());
  c.delete();
  props.delete();
  return point;
}

function expectNormal(face: Shape, expected: Vector3d): void {
  const normal = (face as Face).calculateNormal();
  expect(normal.dot(expected)).toBeCloseTo(1, 9);
}

/** The custom bucket stored at `bucket:<name>`, as the state holds it. */
function stored(obj: SceneObject, name: string): Shape[] {
  return obj.getState(`bucket:${name}`) as Shape[];
}

/** What a remove's cut classified into the standard buckets, by key, each member by its bounds in order. */
function standardBuckets(obj: SceneObject): Record<string, number[][]> {
  return Object.fromEntries(STANDARD_KEYS.map(key => [key, (obj.getState(key) as Shape[] ?? []).map(bounds)]));
}

/** What a pocket call takes after its face. */
type PocketOptions = Parameters<typeof pocket>[1];

/** A pocket builder: the custom one, or the same pocket declaring no buckets of its own. */
type PocketMaker<T> = (face: ISelection, options?: PocketOptions) => T;

/** A pocket sunk into a plate's top face. */
function plateWithPocket(options: PocketOptions = {}): { plate: SceneObject; pocket: PocketFeature } {
  const p = plate();
  return { plate: p, pocket: pocket(p.endFaces(), options) };
}

/** Two 40 mm plates 2 apart, and a pocket 50 long on the left one's centre: out over its left side, and 3 mm into the right plate. */
function acrossTwoPlates<T>(make: PocketMaker<T>): T {
  const a = plate(0, 40);
  plate(42, 40);
  return make(a.endFaces(), { length: 50, radius: 2 });
}

/**
 * A slot cut first to the pocket's depth, running out of the pocket's +X
 * side, then the pocket: its floor comes out of the cut in two pieces, and
 * the cleanup merges them, and the slot's floor, into one face.
 */
function besideASlot<T>(make: PocketMaker<T>): T {
  const p = plate();
  sketch(p.endFaces(), () => {
    testRect(20, 10, { at: [10, -5] });
  });
  cut(POCKET_DEFAULTS.depth);
  return make(p.endFaces());
}

/** Models a pocket cuts, each built with the pocket it is handed. */
const MODELS: [string, (make: PocketMaker<SceneObject>) => SceneObject][] = [
  ['a blind pocket', make => make(plate().endFaces())],
  ['a through pocket', make => make(plate().endFaces(), { depth: PLATE_TOP + 5 })],
  ['a pocket across two plates', acrossTwoPlates],
  ['a pocket whose floor merges with a slot\'s', besideASlot],
];

describe("a removing feature's custom buckets", () => {
  setupOC();

  it("names the pocket floor: one planar face at the pocket's depth, faced out of the material", () => {
    const { pocket: k } = plateWithPocket();
    expect(errorsOf(render())).toEqual([]);

    const floor = resolved(k.floorFaces());
    expect(floor).toHaveLength(1);
    expect(sameShapes(floor, stored(k, 'floorFaces'))).toBe(true);
    expect(FaceOps.tryGetPlane(floor[0] as Face)).not.toBeNull();
    expect(bounds(floor[0])).toEqual([-15, -10, FLOOR, 15, 10, FLOOR]);
    expect(area(floor[0])).toBeCloseTo(FLOOR_AREA, 6);
    // The solid's own face: its normal points up, out of the material into the pocket.
    expectNormal(floor[0], new Vector3d(0, 0, 1));
    expect(allIn(floor, solidsOf(k))).toBe(true);
  });

  it("names the floor's rim, the walls and the vertical edges between them, all on the cut solid", () => {
    const { pocket: k } = plateWithPocket();
    expect(errorsOf(render())).toEqual([]);
    const solids = solidsOf(k);
    const floor = resolved(k.floorFaces())[0] as Face;

    // The rim: the floor's edges, derived from the floor as the cut left it.
    const rim = resolved(k.floorEdges());
    expect(rim).toHaveLength(8);
    expect(sameShapes(rim, floor.getEdges())).toBe(true);
    expect(allIn(rim, solids)).toBe(true);

    // The walls: four straight sides and four corners, from the face down to the floor, faced into the pocket.
    const walls = resolved(k.wallFaces()) as Face[];
    expect(walls).toHaveLength(8);
    expect(allIn(walls, solids)).toBe(true);
    for (const wall of walls) {
      const [, , minZ, , , maxZ] = bounds(wall);
      expect([minZ, maxZ]).toEqual([FLOOR, PLATE_TOP]);
    }
    const sides = walls.filter(wall => FaceOps.tryGetPlane(wall) !== null);
    expect(sides).toHaveLength(4);
    for (const side of sides) {
      const toCentre = new Vector3d(-centroid(side).x, -centroid(side).y, 0).normalize();
      expectNormal(side, toCentre);
    }

    // The wall edges, named explicitly: vertical, and each between two walls.
    const seams = resolved(k.wallEdges()) as Edge[];
    expect(seams).toHaveLength(8);
    expect(allIn(seams, solids)).toBe(true);
    for (const seam of seams) {
      const [minX, minY, minZ, maxX, maxY, maxZ] = bounds(seam);
      expect([maxX - minX, maxY - minY, minZ, maxZ]).toEqual([0, 0, FLOOR, PLATE_TOP]);
      expect(walls.filter(wall => wall.getEdges().some(e => e.getShape().IsSame(seam.getShape())))).toHaveLength(2);
    }
  });

  it("takes a chamfer on the floor rim, and a fillet on a square pocket's wall edges", () => {
    const { pocket: k } = plateWithPocket();
    const broken = chamfer(0.5, k.floorEdges()) as unknown as SceneObject;
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(broken.getError()).toBeNull();
    // The chamfer fills a 0.5 × 0.5 triangle along the rim: the straight
    // sides' 68 mm, and four quarter turns round the corners' axes.
    const strip = 0.125 * (68 + 4 * (Math.PI / 2) * (POCKET_DEFAULTS.radius - 0.5 / 3));
    expect(volumeOf(scene)).toBeCloseTo(PLATE_VOLUME - FLOOR_AREA * POCKET_DEFAULTS.depth + strip, 3);

    getSceneManager().startScene();
    const { pocket: square } = plateWithPocket({ radius: 0 });
    const rounded = fillet(2, square.wallEdges()) as unknown as SceneObject;
    const again = render();
    expect(errorsOf(again)).toEqual([]);
    expect(rounded.getError()).toBeNull();
    expect(stored(square, 'wallEdges')).toHaveLength(4);
    // Each corner keeps a 2 mm round of material, all the way down.
    const corners = 4 * (4 - Math.PI) * POCKET_DEFAULTS.depth;
    expect(volumeOf(again)).toBeCloseTo(PLATE_VOLUME - 600 * POCKET_DEFAULTS.depth + corners, 3);
  });

  it("follows the tool into two separate plates: each member's images from both, in stock order", () => {
    const k = acrossTwoPlates(pocket);
    expect(errorsOf(render())).toEqual([]);

    const solids = solidsOf(k);
    expect(solids.map(bounds)).toEqual([[-20, -20, 0, 20, 20, PLATE_TOP], [22, -20, 0, 62, 20, PLATE_TOP]]);
    const floor = resolved(k.floorFaces());
    expect(floor.map(bounds)).toEqual([[-20, -10, FLOOR, 20, 10, FLOOR], [22, -10, FLOOR, 25, 10, FLOOR]]);
    expect(allIn([floor[0]], [solids[0]])).toBe(true);
    expect(allIn([floor[1]], [solids[1]])).toBe(true);
    floor.forEach(f => expectNormal(f, new Vector3d(0, 0, 1)));
    expect(sameShapes(resolved(k.floorEdges()), floor.flatMap(f => (f as Face).getEdges()))).toBe(true);

    // A long wall crosses the gap: its piece in each plate, the left plate's first.
    const walls = resolved(k.wallFaces());
    expect(walls).toHaveLength(7);
    expect(walls.slice(0, 2).map(bounds)).toEqual([[-20, 10, FLOOR, 20, 10, PLATE_TOP], [22, 10, FLOOR, 23, 10, PLATE_TOP]]);
    expect(allIn(walls, solids)).toBe(true);
    // Only the right plate holds corners of the pocket: their four seams.
    expect(resolved(k.wallEdges()).map(bounds).every(([minX]) => minX >= 22)).toBe(true);
    expect(stored(k, 'wallEdges')).toHaveLength(4);
  });

  it("names no floor when the pocket goes right through, and keeps the walls it cut", () => {
    const { pocket: k } = plateWithPocket({ depth: PLATE_TOP + 5 });
    expect(errorsOf(render())).toEqual([]);

    expect(stored(k, 'floorFaces')).toEqual([]);
    expect(stored(k, 'floorEdges')).toEqual([]);
    expect(resolved(k.floorFaces())).toEqual([]);
    expect(resolved(k.floorEdges())).toEqual([]);
    // The walls and their seams stop at the plate's bottom.
    const walls = resolved(k.wallFaces());
    expect(walls).toHaveLength(8);
    expect(walls.every(w => bounds(w)[2] === 0 && bounds(w)[5] === PLATE_TOP)).toBe(true);
    const seams = resolved(k.wallEdges());
    expect(seams).toHaveLength(8);
    expect(allIn([...walls, ...seams], solidsOf(k))).toBe(true);
  });

  it("keeps one floor, once, where the face merge folds two floor pieces into one", () => {
    const k = besideASlot(pocket);
    expect(errorsOf(render())).toEqual([]);

    const floor = resolved(k.floorFaces());
    expect(floor).toHaveLength(1);
    expect(stored(k, 'floorFaces')).toHaveLength(1);
    expect(bounds(floor[0])).toEqual([-15, -10, FLOOR, 30, 10, FLOOR]);
    // The pocket's floor and the slot's, less where they overlap.
    expect(area(floor[0])).toBeCloseTo(FLOOR_AREA + 20 * 10 - 5 * 10, 6);
    expectNormal(floor[0], new Vector3d(0, 0, 1));
    expect(allIn(floor, solidsOf(k))).toBe(true);
    expect(sameShapes(resolved(k.floorEdges()), (floor[0] as Face).getEdges())).toBe(true);
  });

  it.each(MODELS)("classifies the standard buckets of %s exactly as it does without custom buckets", (_name, model) => {
    const custom = model(pocket as PocketMaker<SceneObject>);
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(stored(custom, 'wallFaces').length).toBeGreaterThan(0);

    getSceneManager().startScene();
    // The same model, built by the same pocket declaring no buckets of its own.
    const plain = model(definePlainPocket().pocket as PocketMaker<SceneObject>);
    const plainScene = render();
    expect(errorsOf(plainScene)).toEqual([]);
    expect(plain.getState('bucket:wallFaces')).toBeUndefined();

    expect(standardBuckets(custom)).toEqual(standardBuckets(plain));
    expect(standardBuckets(custom)['section-edges'].length).toBeGreaterThan(0);
    expect(volumeOf(scene)).toBeCloseTo(volumeOf(plainScene), 6);
  });
});

describe("a custom feature's buckets when it keeps its tool apart", () => {
  setupOC();

  it("names the pocket's own solid as built, like a feature that adds: its floor faces down, out of it", () => {
    const { plate: p, pocket: k } = plateWithPocket();
    k.new();
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);

    const solids = solidsOf(k);
    expect(solids).toHaveLength(1);
    expect(ShapeProps.getProperties(solids[0].getShape()).volumeMm3).toBeCloseTo(FLOOR_AREA * POCKET_DEFAULTS.depth, 6);
    expect(volumeOf(scene)).toBeCloseTo(PLATE_VOLUME + FLOOR_AREA * POCKET_DEFAULTS.depth, 6);
    expect(solidsOf(p)).toHaveLength(1);

    const floor = resolved(k.floorFaces());
    expect(floor.map(bounds)).toEqual([[-15, -10, FLOOR, 15, 10, FLOOR]]);
    expectNormal(floor[0], new Vector3d(0, 0, -1));
    expect(sameShapes(resolved(k.floorEdges()), (floor[0] as Face).getEdges())).toBe(true);
    expect(resolved(k.wallFaces())).toHaveLength(8);
    expect(resolved(k.wallEdges())).toHaveLength(8);
    expect(allIn(['floorFaces', 'floorEdges', 'wallFaces', 'wallEdges'].flatMap(name => stored(k, name)), solids)).toBe(true);
  });
});

describe("a removing feature's custom buckets under repeat", () => {
  setupOC();

  it("gives each copy of a linear repeat its own floor, where the copy cut it", () => {
    // A 100 mm plate centred on x = 30, and pockets at x = 30, 50 and 70.
    const p = plate(30, 100);
    const k = pocket(p.endFaces(), { length: 16, width: 10, radius: 2 });
    const r = repeat("linear", "x", { count: 3, offset: 20 }, k as never) as unknown as { instance(slot: number): { getRoots(): SceneObject[] } };
    expect(errorsOf(render())).toEqual([]);

    const original = resolved(k.floorFaces());
    expect(original.map(bounds)).toEqual([[22, -5, FLOOR, 38, 5, FLOOR]]);
    const copies = [1, 2].map(slot => r.instance(slot).getRoots()[0] as unknown as PocketFeature);
    copies.forEach((copy, i) => {
      expect(copy).not.toBe(k);
      const floor = resolved(copy.floorFaces());
      expect(floor.map(bounds)).toEqual([[42 + 20 * i, -5, FLOOR, 58 + 20 * i, 5, FLOOR]]);
      expectNormal(floor[0], new Vector3d(0, 0, 1));
      expect(resolved(copy.floorEdges())).toHaveLength(8);
      expect(resolved(copy.wallFaces())).toHaveLength(8);
    });
    // The last copy holds the plate as every cut left it, and every floor is a face of it.
    const last = solidsOf(copies[1]);
    expect(last).toHaveLength(1);
    expect(allIn([...original, ...copies.flatMap(copy => resolved(copy.floorFaces()))], last)).toBe(true);
  });
});

describe("the cut's tool images", () => {
  setupOC();

  /**
   * A drum of radius 10, 10 tall, and a pin of radius 4 standing from 4
   * below its top to 1 above it: the pin, and its bottom, top and side faces.
   */
  function drumAndPin() {
    const drum = Primitives.makeCylinder(10, 10);
    const pin = ShapeOps.transform(Primitives.makeCylinder(4, 5), Matrix4.fromTranslation(0, 0, 6));
    const faces = pin.getSubShapes('face') as Face[];
    const bottom = faces.find(f => bounds(f)[5] === 6)!;
    const top = faces.find(f => bounds(f)[2] === 11)!;
    const side = faces.find(f => f !== bottom && f !== top)!;
    return { drum, pin, bottom, top, side };
  }

  it("follows each tracked member through a stock's cut: what the cut left of it, nothing of a face outside", () => {
    const { drum, pin, bottom, top, side } = drumAndPin();
    const cut = BooleanOps.cutMultiShape([drum], [pin], undefined, 0, { trackTool: [bottom, top, side] });
    try {
      expect(cut.toolImages(bottom).map(bounds)).toEqual([[-4, -4, 6, 4, 4, 6]]);
      // The pin's top stands above the drum: the cut deleted it.
      expect(cut.toolImages(top)).toEqual([]);
      // Its side, trimmed to where the drum held it.
      expect(cut.toolImages(side).map(bounds)).toEqual([[-4, -4, 6, 4, 4, 10]]);
      // A member is found as the same sub-shape too; one never tracked has none.
      expect(cut.toolImages(Face.fromTopoDSFace(bottom.getShape()))).toHaveLength(1);
      expect(cut.toolImages(drum.getSubShapes('face')[0])).toEqual([]);
    } finally {
      cut.dispose();
    }
  });

  it("settles each image on the result's own face: the floor the pin left faces up, out of the drum", () => {
    const { drum, pin, bottom } = drumAndPin();
    const cut = BooleanOps.cutMultiShape([drum], [pin], undefined, 0, { trackTool: [bottom] });
    try {
      const [image] = cut.toolImages(bottom);
      // The kernel hands the image back as the pin had it, facing down.
      expect((image as Face).calculateNormal().z).toBeCloseTo(-1, 9);
      const [[settled]] = CutToolImages.settle([[image]], [], cut.modified(drum));
      expect(settled.getShape().IsSame(image.getShape())).toBe(true);
      expect((settled as Face).calculateNormal().z).toBeCloseTo(1, 9);
      // What the result doesn't carry is dropped.
      expect(CutToolImages.settle([[image]], [], [Primitives.makeCylinder(1, 1)])).toEqual([[]]);
    } finally {
      cut.dispose();
    }
  });

  it("gathers nothing without members to track, and cuts the same either way", () => {
    const { drum, pin, bottom } = drumAndPin();
    const tracked = BooleanOps.cutMultiShape([drum], [pin], undefined, 0, { trackTool: [bottom] });
    const plain = BooleanOps.cutMultiShape([drum], [pin]);
    try {
      expect(plain.toolImages(bottom)).toEqual([]);
      expect(plain.sectionEdges.map(bounds)).toEqual(tracked.sectionEdges.map(bounds));
      expect(plain.internalFaces.map(bounds)).toEqual(tracked.internalFaces.map(bounds));
      expect(plain.modified(drum).map(bounds)).toEqual(tracked.modified(drum).map(bounds));
    } finally {
      tracked.dispose();
      plain.dispose();
    }
  });
});
