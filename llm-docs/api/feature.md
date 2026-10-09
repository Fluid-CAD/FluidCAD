---
id: api/feature
title: "Feature / Feature.with(params) — the base class of a custom feature"
summary: "The class a custom feature extends, from fluidcad/sdk: Feature.with({ … }) declares its values and types this.values; static id names it; a tool implements buildTool(ctx) and returns its solids (the base applies add/new/remove, fuses or cuts, moves them for a repeat), a modifier overrides build(ctx). setBuckets() names startFaces…capFaces (edges derived) plus startPlane; shapesOf/facesOf/edgesOf/axisOf/planeOf/frameOf/pointOf/isLocation read the picked references; getOperationMode() reads the operation the statement applies (chain or default, the dialog's tab in the preview, the same on a repeat's copy); ghost(ctx) is the dialog's preview; occ() runs raw OpenCascade in a scope."
tags: [api, sdk, custom-feature, type]
symbols: [Feature, FeatureBuckets, FeatureBuildContext]
seeAlso: [concepts/custom-features, api/define-feature, api/feature-params, api/sdk-kernel, api/sdk-occt, api/register-builder, api/connector, api/repeat]
---

# Feature

Imported from `fluidcad/sdk`.

```ts
class MyFeature extends Feature.with(params) {   // params: { [name]: ParamSpec }
  static id = 'acme.myFeature';                  // namespaced: the timeline type and the cache's

  readonly values: ValuesOf<params>;             // frozen; a length is a number, a face pick an ISelection

  // A tool implements:
  buildTool(ctx: FeatureBuildContext): Shape[];
  // A modifier overrides instead:
  build(ctx: FeatureBuildContext): void;
  // Optional — the dialog's preview:
  ghost(ctx: FeatureBuildContext): Shape[] | null;

  // The operation this statement applies — its chain's, else the default:
  getOperationMode(): 'add' | 'new' | 'remove';

  // Protected helpers:
  setBuckets(buckets: FeatureBuckets): void;
  shapesOf(ref: ISceneObject | ISceneObject[]): Shape[];
  facesOf(ref: ISceneObject | ISceneObject[]): Face[];
  edgesOf(ref: ISceneObject | ISceneObject[]): Edge[];
  axisOf(ref: ISceneObject): Axis;
  planeOf(ref: ISceneObject): Plane;
  frameOf(ref: ISceneObject): Plane;
  pointOf(ref: ISceneObject): Point;
  isLocation(ref: ISceneObject): boolean;
  occ<T>(fn: (scope: OccScope) => T): T;
}

type FeatureBuckets = {
  startFaces?: Face[]; endFaces?: Face[]; sideFaces?: Face[]; internalFaces?: Face[]; capFaces?: Face[];
  startEdges?: Edge[]; endEdges?: Edge[]; sideEdges?: Edge[]; internalEdges?: Edge[]; capEdges?: Edge[];
  startPlane?: Plane;
};

// What a model gets from every feature, as from a built-in:
f.startFaces(...)  f.endFaces(...)  f.sideFaces(...)  f.internalFaces(...)  f.capFaces(...)
f.startEdges(...)  f.endEdges(...)  f.sideEdges(...)  f.internalEdges(...)  f.capEdges(...)
f.edges(...)                        // every edge a remove created
f.add()  f.new()  f.remove()  f.scope(...solids)  f.name(label)
```

`Shape`, `Face`, `Edge` come from `fluidcad/sdk/kernel` ([[api/sdk-kernel]]);
`Axis`, `Plane`, `Point` from `fluidcad/math`. The accessors take indices and
filters as `extrude()`'s do: `f.endEdges(0)`, `f.sideFaces(face().cylinder())`.

## Declaring the values: `Feature.with(params)`

`Feature.with({ … })` returns an abstract base whose `this.values` is typed
from `params`, and which carries them as `static params` for
`defineFeature()`. Each value is typed in (`type`) or picked (`picker`) —
see [[api/feature-params]] for every kind and option.

| Declared | `this.values.<name>` |
|---|---|
| `number`, `integer`, `length`, `angle` | `number` (a length in the model file's unit, an angle in degrees) |
| `boolean` | `boolean` |
| `text` | `string` |
| `select` | the union of its options' values (`'m3' \| 'm4'`) |
| `face` or `edge` picker | `ISelection` (`ISelection[]` for a list) |
| any other picker, or a union | `ISceneObject` (`[]` for a list; `ISelection` when every kind is a face or edge) |

A value is `| undefined` only when the call may leave it out and nothing
fills it: `optional: true` (or a sketch with `implicitDefault: true`) with no
`default`, and not a list (a list left out is `[]`). A boolean without a
default is `false` and a select without one its first option, so neither is
`| undefined` unless the select is optional. Every declared name is
present in `this.values`, so the cache's key set never depends on how the
call was written.

`static id` is required and namespaced: dot-separated names of letters,
digits, `-` and `_`, each starting with a letter (`'acme.standoff'`). Plain
ids are the engine's own. A class declares **no constructor**: the
framework constructs a feature from its values alone, and a repeat's copy is
the same class constructed from the same values.

## Tool kind: `buildTool(ctx)`

Return the solids the feature adds or cuts, built where its references stand
now. Then the base:

1. applies the operation the statement chose — `.add()` fuses into the
   solids in scope, `.new()` keeps the solids apart, `.remove()` cuts — or,
   with no chain, the feature's default (`add` when its metadata offers it,
   else the first operation it lists);
2. narrows the solids to `.scope(...)`'s, when given;
3. records the history, and carries the buckets `setBuckets()` named
   across the fusion.

A `repeat()`'s copy builds the tool again from the same references, read
where they stand, and moves it: the references are never copied (copying
the face a standoff stands on would copy the plate with it), and the buckets
move with the tool. `copy()` duplicates the finished solid. Returning
no shape fails the row: `acme.x: buildTool() returned no shapes`.

`ctx` is the scene as it stands before the feature: `ctx.getSceneObjects()`
lists the objects in scope. A tool rarely needs it.

**Reading the operation: `this.getOperationMode()`** returns `'add'`,
`'new'` or `'remove'` — the operation the base applies to what `buildTool()`
returns: the statement's chain, or with no chain the feature's default
(never null; a feature that declares no `operations` reads `'add'` unless a
chain says otherwise). It reads the same in `buildTool()`, in the dialog's
preview (the tab the dialog shows, the default for a feature without tabs)
and on every `repeat()` copy (its statement's). A chain the feature doesn't
offer fails the row before `buildTool()` runs. Under checkJs it is typed
`'add' | 'new' | 'remove'`, so a misspelt `'cut'` is flagged. Read it when a
remove means a different tool: an internal gear adds the whole ring but
removes only the tooth space. Here, a tube cuts only its bore:

```feature.js
// tube.feature.js
// A tube standing on XY: added or new, the tube; removed, only its bore.
import { Feature, defineFeature } from 'fluidcad/sdk';
import { BooleanOps, Primitives } from 'fluidcad/sdk/kernel';

export class Tube extends Feature.with({
  outer: { type: 'length', default: 12, min: 0 },
  bore: { type: 'length', default: 8, min: 0 },
  height: { type: 'length', default: 10, min: 0 },
}) {
  static id = 'acme.tube';

  buildTool() {
    const { outer, bore, height } = this.values;
    const space = Primitives.makeCylinder(bore / 2, height);
    if (this.getOperationMode() === 'remove') {
      return [space];
    }
    const body = Primitives.makeCylinder(outer / 2, height);
    const tube = BooleanOps.cutShapes(body, space);
    body.dispose();
    space.dispose();
    return [tube];
  }
}

export const tube = defineFeature(Tube, {
  label: 'Tube',
  group: 'create',
  operations: ['add', 'new', 'remove'],
  call: [{ outer: 'outer', bore: 'bore', height: 'height' }],
});
```

```fluid.js
import { part, cylinder } from "fluidcad/core";
import { tube } from "./tube.feature.js";

export const hub = part("Hub", () => {
  cylinder(20, 10);
  tube({ height: 25 });            // fuses a Ø12 tube into the Ø40 disk
  tube({ height: 25 }).remove();   // bores Ø8 through both; the tube's wall stays
});
```

## Naming the buckets: `setBuckets(buckets)`

Downstream features name the feature's faces and edges through its
accessors (`post.endEdges()`), and the editor's picks on its geometry are
written the same way. A feature fills only the buckets it declares:

- **A tool** names sub-shapes of the solids `buildTool()` returns. The base
  moves them with a repeat's copy and carries them across the fusion.
- **Edge buckets left out are derived** from the face buckets: a start
  face's edges are start edges, and so on (the extrude rule).
- **`startPlane`** is the plane the tool starts on, its normal pointing the
  way the tool grows. A **remove** keeps none of the tool's face buckets: the
  cut classifies what it made, as `cut()` does — its rims as start edges
  (where the tool enters the material) and end edges (its far end), its walls
  as internal faces. Without `startPlane` every rim is internal.
  `f.edges()` lists every edge a remove created.
- **A modifier** names its final geometry; the buckets land at once.
- Calls accumulate. Buckets are the standard ones only — there are no custom
  names.

## Reading the references

The picked values are scene objects; read them through these helpers rather
than their own methods (a preview hands the feature stand-ins, never the
scene's objects).

| Helper | Reads |
|---|---|
| `shapesOf(ref)` | every shape a reference holds now: a selection's faces or edges, a solid's solids, a sketch's wires |
| `facesOf(ref)` | its faces: a face selection's faces, a solid's faces |
| `edgesOf(ref)` | its edges: an edge selection's edges, a face's or a solid's edges |
| `axisOf(ref)` | the `Axis` of an axis value: a world axis (`'z'`), an `axis()` statement, a picked straight edge, or a connector (its Z axis through its origin, a copy's too) |
| `planeOf(ref)` | the `Plane` of a plane value: an origin plane (`'xy'`), a `plane()` statement, a picked planar face |
| `frameOf(ref)` | the frame a location stands on: origin at the location, Z out of the material (below) |
| `pointOf(ref)` | the world position of a location |
| `isLocation(ref)` | whether an element is a connector, a point or an anchor — how a `['solid', 'connector']` value tells its elements apart |

Each accepts a list too (`shapesOf`, `facesOf`, `edgesOf`). `axisOf` refuses
anything but an axis value ("… is not an axis — declare the value as an
axis picker"), `planeOf` likewise, and `frameOf`/`pointOf` anything but a
location.

**The frame of a location** (`frameOf`): a connector gives its own frame; a
face anchor (`e.endFaces().center()`) the face's normal; a circular edge's
`center()` the circle's axis; an edge's `start()`/`end()` the edge's tangent
there — so a vertex named as an edge's end faces along that edge, not out of
a face; a sketch point its sketch's plane; any other point world Z. All of
them where they stand now: a repeat moves the tool the feature builds there,
not the location.

**What the feature consumes.** From the feature on, the selections and
sketches it reads leave the screen (the selection an anchor stands on and
the sketch a point is drawn in too), but they stay readable: a repeat's
copies read them again. A referenced solid, feature or connector stays.

## The preview: `ghost(ctx)`

While the dialog's **Preview** toggle is on, the engine builds the feature
from the dialog's values on stand-ins of the picks and draws what `ghost()`
returns — green for an add or a new, red for a remove — again on every
change. The scene is never changed.

- **The toggle starts off**: the engine runs neither `ghost()` nor
  `buildTool()` for the dialog until the user turns it on. The page
  remembers it per feature id, so a feature the user turned it on for opens
  with it on; turning it off forgets it. Apply never depends on it.

- **A tool** previews by default: `ghost()` runs `buildTool()`. Override it
  to return something cheaper.
- **A modifier** draws nothing unless it overrides `ghost()`; it may return
  solids, faces (drawn as patches) or edges.
- The preview frees every shape `ghost()` returns once it is drawn, except
  one the scene itself holds — return shapes built here.
- **Time-out:** a preview that takes over 5 s to build and mesh is not
  drawn, and the dialog asks for no more: it says "Preview timed out. It
  took 6.2 s to build, over the 5 s a preview may take. Turn it off and on
  to try again." Turning the toggle off and on, saving the feature's module
  or opening the dialog again asks again.
- `ghost: false` in the metadata turns the preview off: the dialog shows no
  toggle.

## Modifier kind: `build(ctx)`

A modifier overrides `build(ctx)` and changes the scene's solids directly,
the way `fillet()` and `draft()` do; `draft()` is the engine's own modifier
on this base. It declares no `operations` (its `build()` decides what it
does), and a repeat's copy rebuilds it from copies of its references. Its
`build()` reaches the solids through the build context and the scene
objects' own methods — `ctx.getSceneObjects()`, `obj.getShapes(…)`,
`owner.removeShape(old, this, [replacement])`, `this.addShapes(…)` — which
are the engine's internals rather than a settled SDK surface. Prefer the
tool kind whenever the feature adds or removes material.

## The cache

Two statements match when their ids match and their values match — scalars
by value, references by their own comparison — so a forgotten field can
never serve stale geometry, and nothing to write by hand. The class is never
compared: the module is evaluated anew on every render, so the same feature
arrives as a new class each time. **Never `instanceof` your own class**
(`instanceof Feature` is fine). Saving the module's code rebuilds its
statements (see [[concepts/custom-features]]).

## Example: bosses at connectors and sketch points

A union picker of locations, `frameOf()`, several tools from one statement,
and their buckets:

```feature.js
// boss.feature.js
// Bolt-pattern bosses — a cylinder with a bore — standing at every location
// they are handed: a connector, a point or a face centre.
import { Feature, defineFeature } from 'fluidcad/sdk';
import { BooleanOps, Primitives, ShapeOps } from 'fluidcad/sdk/kernel';
import { Matrix4 } from 'fluidcad/math';

export class Boss extends Feature.with({
  at: { picker: ['connector', 'point', 'anchor'], multiple: true, anchors: ['center'], label: 'At' },
  diameter: { type: 'length', default: 8, min: 0, label: 'Boss diameter' },
  height: { type: 'length', default: 6, min: 0 },
  hole: { type: 'length', default: 3, min: 0, label: 'Hole diameter' },
}) {
  static id = 'acme.boss';

  buildTool() {
    const { at, diameter, height, hole } = this.values;
    if (!(hole < diameter)) {
      throw new Error(`boss: the hole (${hole}) must be narrower than the boss (${diameter})`);
    }
    if (at.length === 0) {
      throw new Error('boss: pick where the bosses stand — a connector, a point or a face centre');
    }
    const tolerance = 1e-6 * Math.max(height, diameter);
    const frames = at.map(location => this.frameOf(location));
    const bosses = frames.map(frame => {
      // One boss built on the XY plane, its faces sorted there, then placed
      // on the frame — growing along the frame's Z.
      const cylinder = Primitives.makeCylinder(diameter / 2, height);
      const bore = hole > 0 ? Primitives.makeCylinder(hole / 2, height) : null;
      const solid = bore ? BooleanOps.cutShapes(cylinder, bore) : cylinder;
      if (bore) {
        cylinder.dispose();
        bore.dispose();
      }
      const all = solid.getSubShapes('face');
      const start = all.filter(f => Math.abs(f.getBoundingBox().maxZ) < tolerance);
      const end = all.filter(f => Math.abs(f.getBoundingBox().minZ - height) < tolerance);
      const walls = all.filter(f => !start.includes(f) && !end.includes(f));
      const side = walls.filter(f => f.getBoundingBox().maxX > hole / 2 + tolerance);
      const internal = walls.filter(f => !side.includes(f));

      const placement = Matrix4.fromBasis(frame.xDirection, frame.yDirection, frame.normal, frame.origin);
      const placed = ShapeOps.transformTracking(solid, placement, all);
      solid.dispose();
      const [startFaces, endFaces, sideFaces, internalFaces] = [start, end, side, internal]
        .map(group => group.map(f => placed.images[all.indexOf(f)]).filter(f => f !== null));
      return { shape: placed.shape, startFaces, endFaces, sideFaces, internalFaces };
    });
    this.setBuckets({
      startFaces: bosses.flatMap(b => b.startFaces),
      endFaces: bosses.flatMap(b => b.endFaces),
      sideFaces: bosses.flatMap(b => b.sideFaces),
      internalFaces: bosses.flatMap(b => b.internalFaces),
      startPlane: frames[0],
    });
    return bosses.map(b => b.shape);
  }
}

export const boss = defineFeature(Boss, {
  label: 'Boss',
  description: 'Bosses with a bore, standing at connectors, points and face centres',
  group: 'create',
  operations: ['add', 'new'],
  call: ['at', { diameter: 'diameter', height: 'height', hole: 'hole' }],
});
```

A mounting plate with a connector, a copy of it, and a sketch point:

```fluid.js
import { part, sketch, line, point, extrude, connector, copy, select, chamfer } from "fluidcad/core";
import { coincident, horizontal, vertical, distance, fix } from "fluidcad/constraints";
import { face } from "fluidcad/filters";
import { boss } from "./boss.feature.js";

export const mountingPlate = part("Mounting plate", () => {
  sketch("xy", () => {
    const b = line([-31, -21], [29, -19]);
    const r = line([29, -19], [31, 21]);
    const t = line([31, 21], [-29, 19]);
    const l = line([-29, 19], [-31, -21]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [-30, -20]);
    distance(b.start(), b.end(), 60);
    distance(r.start(), r.end(), 40);
  });
  const plate = extrude(6);

  // A connector at the centre of the top, and a copy of it 20 mm along x.
  const bolt = connector("bolt", select(face().planar().onPlane("xy", 6)));
  copy("linear", "x", { count: 2, offset: 20 }, bolt);

  const marks = sketch(plate.endFaces(), () => {
    const m1 = point([-20, 10]);
    fix(m1, [-20, 10]);
    return { m1 };
  });

  // Three bosses: at the connector, at its copy, and at the sketch point.
  const bosses = boss([bolt, bolt.instance(1), marks.geometries.m1], { height: 4 });
  chamfer(0.5, bosses.endEdges());
});
```

See [[api/define-feature]] for the metadata, [[api/feature-params]] for the
values and pickers, [[api/connector]] for connectors and their copies.
