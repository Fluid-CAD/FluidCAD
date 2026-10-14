---
id: api/feature
title: "Feature / Feature.with(params) — the base class of a custom feature"
summary: "The class a custom feature extends, from fluidcad/sdk: Feature.with({ … }, { buckets }) declares its values (typing this.values) and its own named buckets; static id names it; a tool implements buildTool(ctx) and returns its solids (the base applies add/new/remove, fuses or cuts, moves them for a repeat), a modifier overrides build(ctx). setBuckets() names startFaces…capFaces (edges derived) plus startPlane, and each declared bucket: Feature.with(params, { buckets: { tipFaces: {}, tipEdges: {} } }) gives the feature real methods g.tipFaces()/g.tipEdges() (a name ends in Faces or Edges; a declaration holds only a label; a declared xEdges left out is the edges of xFaces), which a fusion follows (dropping what it removed), a remove maps through its cut and a repeat's copy moves (r.instance(k).tipEdges()), and which the editor writes picks through first; setBuckets() refuses unknown names, non-lists, wrong kinds and members outside the returned solids. shapesOf/facesOf/edgesOf/axisOf/planeOf/frameOf/pointOf/isLocation read the picked references; getOperationMode() reads the operation the statement applies; ghost(ctx) is the dialog's preview; occ() runs raw OpenCascade in a scope."
tags: [api, sdk, custom-feature, type]
symbols: [Feature, FeatureBuckets, FeatureBuildContext, FeatureWithOptions, FeatureBucketSpec, FeatureBucketSpecs]
seeAlso: [concepts/custom-features, api/define-feature, api/feature-params, api/sdk-kernel, api/sdk-occt, api/register-builder, api/connector, api/repeat]
---

# Feature

Imported from `fluidcad/sdk`.

```ts
class MyFeature extends Feature.with(params, { buckets }) {   // params: { [name]: ParamSpec }; the options are optional
  static id = 'myFeature';                       // plain: the timeline type and the cache's

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
  setBuckets(buckets: FeatureBuckets & { [declared: string]: Face[] | Edge[] }): void;
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

// Feature.with()'s second argument: the feature's own named buckets.
type FeatureWithOptions = { buckets?: FeatureBucketSpecs };
type FeatureBucketSpecs = { [name: string]: FeatureBucketSpec };   // name: /^[a-z][A-Za-z0-9]*(Faces|Edges)$/
type FeatureBucketSpec = { label?: string };                        // the menus' words; nothing else

// What a model gets from every feature, as from a built-in:
f.startFaces(...)  f.endFaces(...)  f.sideFaces(...)  f.internalFaces(...)  f.capFaces(...)
f.startEdges(...)  f.endEdges(...)  f.sideEdges(...)  f.internalEdges(...)  f.capEdges(...)
f.edges(...)                        // every edge a remove created
f.add()  f.new()  f.remove()  f.scope(...solids)  f.name(label)
// And one method per bucket its class declares:
g.tipFaces(...)  g.tipEdges(...)    // r.instance(k).tipEdges(...) on a repeat's copy
```

`Shape`, `Face`, `Edge` come from `fluidcad/sdk/kernel` ([[api/sdk-kernel]]);
`Axis`, `Plane`, `Point` from `fluidcad/math`. The accessors take indices and
filters as `extrude()`'s do: `f.endEdges(0)`, `f.sideFaces(face().cylinder())`.

## Declaring the values: `Feature.with(params)`

`Feature.with({ … })` returns an abstract base whose `this.values` is typed
from `params`, and which carries them as `static params` for
`defineFeature()`. Each value is typed in (`type`) or picked (`picker`) —
see [[api/feature-params]] for every kind and option. Its optional second
argument, `{ buckets }`, declares the feature's own named buckets (see
*Named buckets* below).

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

`static id` is required: a plain name of letters, digits, `-` and `_`,
starting with a letter (`'standoff'`); dot-separated names (`'acme.standoff'`)
are accepted too. It may not be one of the engine's own scene types
(`extrude`, `fillet`, `part`, `sketch`, `distance`, …): "'extrude' is one of
the engine's own types: give the feature another id". `getType()` answers
the id, keyed by the package for a class an installed package defines
(`@acme/mounting-hardware:standoff`); models never write that key. A class
declares **no constructor**: the
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
no shape fails the row: `standoff: buildTool() returned no shapes`.

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
  static id = 'tube';

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
accessors (`post.endEdges()`, `g.tipEdges()`), and the editor's picks on its
geometry are written the same way. A feature fills only the buckets it
names: the standard ones, and the ones its class declares (see *Named
buckets* below).

- **A tool** names sub-shapes of the solids `buildTool()` returns. The base
  moves them with a repeat's copy and carries them across the fusion.
- **Edge buckets left out are derived** from the face buckets: a start
  face's edges are start edges, and so on (the extrude rule). A declared
  `xEdges` left out is the edges of `xFaces`.
- **`startPlane`** is the plane the tool starts on, its normal pointing the
  way the tool grows. A **remove** keeps none of the tool's standard face
  buckets: the cut classifies what it made, as `cut()` does — its rims as
  start edges (where the tool enters the material) and end edges (its far
  end), its walls as internal faces. Without `startPlane` every rim is
  internal. `f.edges()` lists every edge a remove created. A remove's named
  buckets follow the cut instead (below).
- **A modifier** names its final geometry; the buckets land at once.
- Calls accumulate. A value left `undefined` names nothing.

**Refused as the row's build error**, for standard and declared names alike
(the dialog's preview shows the same message; `render()` never throws):

| `setBuckets()` was handed | The row's error |
|---|---|
| a name that is no bucket of the feature | `gear: setBuckets() 'tipFace' is not a bucket of gear — did you mean tipFaces?` (with no name close, it lists the feature's buckets) |
| a value that is not a list | `gear: setBuckets() tipFaces must be a list of faces, got a face` |
| a member of the wrong kind | `gear: setBuckets() tipFaces[0] is an edge, not a face — tipFaces holds faces` |
| a tool's member that is no face or edge of the solids `buildTool()` returned (a face of the shape before `transformTracking` placed it) | `gear: setBuckets() boreFaces[1] is not a face of the solids buildTool() returned — name faces of the shapes you return` |
| a `startPlane` that is not a `Plane` | `gear: setBuckets() startPlane must be a plane, got 'xy'` |
| anything but an object of buckets by name | `gear: setBuckets() takes the buckets by name, such as { endFaces: [face] } — got a list` |

So a misspelt bucket fails where it is filled, not later as an empty bucket
that a fillet finds nothing in.

## Named buckets: `Feature.with(params, { buckets })`

The standard buckets say where a face sits the way an extrude's do. When the
feature's result has parts with names of their own — a gear's tooth tips, a
pocket's floor — declare them, and each becomes a method a model calls like
`endFaces()`. Declare the buckets a user will fillet, chamfer or sketch on:

```js
export class Gear extends Feature.with({ /* … values … */ }, {
  buckets: {
    tipFaces: {},                       // the top land of every tooth, in tooth order
    tipEdges: {},                       // declared, not filled: the edges of tipFaces
    flankFaces: {},                     // two per tooth, in tooth order
    boreFaces: {},                      // the wall of the shaft hole
    boreEdges: { label: 'Bore Rims' },  // the menus read "Gear Bore Rims"
  },
}) {
  static id = 'gear';

  buildTool() {
    // … build the solid, sort its faces, place it …
    this.setBuckets({ startFaces, endFaces, sideFaces, tipFaces, flankFaces, boreFaces });
    return [solid];
  }
}

// In a model:
const g = gear(seat.endFaces(), { teeth: 18 }).new();
fillet(0.3, g.tipEdges());                // every tooth tip
chamfer(0.5, g.boreEdges(0));             // indices and filters, as endEdges() takes them
```

- **The name is the accessor, and its ending is what it holds**: a
  `…Faces` bucket holds faces, an `…Edges` bucket edges. A lowercase letter,
  then letters and digits, ending in `Faces` or `Edges` with a name before
  it (`/^[a-z][A-Za-z0-9]*(Faces|Edges)$/`), at most 48 characters; at most
  32 buckets a class.
- **A declaration is `{}` or `{ label }`.** `label` is what the editor's
  menus call the bucket; left out, the name made readable (`tipEdges` →
  "Tip Edges"). The menus put the feature's label first: "Gear Tip Edges",
  "Gear Bore Rims". There is no `description`: say what each bucket holds,
  and in what order, in the package's `docs/` page for the feature
  (`docs/gear.md`), which other authors and the LLM read. A line comment
  beside the declaration is for whoever reads the code.
- **A standard name** is declared only to relabel it: `endFaces: { label:
  'Top Face' }` makes no new method.
- **Edge buckets are opt-in.** `g.tipEdges()` exists because `tipEdges` is
  declared; `g.flankEdges()` doesn't. A declared `xEdges` that `setBuckets()`
  leaves out is the distinct edges of `xFaces`, taken after the fusion or the
  cut. Fill an edge bucket explicitly when it is not every edge of a face
  bucket (a pocket's vertical corner edges).
- **Checked where the module loads**, by `Feature.with()` (by
  `registerBuilder` for a plain subclass): the model importing the module
  fails to compile and its Custom cell greys, with one of:

  | Declared | Refused with |
  |---|---|
  | a name without the ending | `Feature.with(): 'teeth' needs to end in Faces or Edges (teethFaces?)` |
  | the ending alone | `Feature.with(): 'Faces' needs a name before Faces, such as tipFaces` |
  | a description | `Feature.with(): bucket 'tipFaces': leave 'description' out — describe what the feature's buckets hold in the package's docs/ pages` |
  | a kind | `Feature.with(): bucket 'tipFaces': leave 'kind' out — the name's ending gives it: a …Faces bucket holds faces, an …Edges bucket edges` |
  | any other field | `Feature.with(): bucket 'tipFaces': unknown field 'note' — a bucket declares only its label` |
  | a name every feature already has | `Feature.with(): 'getAddedFaces' is already a member of SceneObject — give the bucket another name` |
  | a method of the same name written on the class | `feature 'gear': Gear writes tipFaces() itself — the declared bucket makes that accessor; remove the method or rename the bucket` |
  | more than 32 | `Feature.with(): declares 33 buckets — a feature declares at most 32` |

- **`buckets` in the metadata is refused**: `defineFeature(Gear): leave
  'buckets' out — declare buckets on the class: Feature.with(params, {
  buckets })`.
- **Typed under checkJs.** `g.tipEdges()` is an `ISelection`, and
  `g.tipEdge()` is an editor error ("Property 'tipEdge' does not exist on
  type 'Gear'. Did you mean 'tipEdges'?"), as is a misspelt name in
  `setBuckets()`. A repeat of one gear types `r.instance(k).tipEdges()`.
- **A plain subclass** (the [[api/register-builder]] path) declares
  `static buckets = { boreFaces: {}, boreEdges: {} }`: the same checks and
  the same methods at run time, but no types. `Feature.with()` is the typed
  path.

**What a named bucket holds after the operation:**

| The statement | Its named buckets |
|---|---|
| `.add()` | Each member followed through the fusion, keeping only what the final solid carries: a face the stock swallowed is dropped, a face the stock cut short is the piece that is left. Nothing is re-homed: a face that merges into the stock leaves the bucket. (`startFaces` is re-homed to the stock face it merged into, so name the face a feature grows from `startFaces`, not a bucket of your own.) |
| `.new()` | The members as built. |
| `.remove()` | Each member becomes what the cut left of it: a pocket's `floorFaces` is the floor the cut made, faced out of the material, and its derived `floorEdges` the floor's rim. A member the cut removes entirely is dropped, so a pocket that goes right through has no floor and `p.floorFaces()` is empty. The standard buckets are the cut's own classification, as above. |
| a `repeat()` copy | Its own members, moved with it: `r.instance(2).tipEdges()` reads copy 2's (when the slot holds that one feature; with several, the accessor says it is ambiguous). On a mirror, `m.instance(1).tipFaces(i)` is the mirror image of `g.tipFaces(i)`. |
| a modifier | Its final geometry, at once. |

A gear fused into a plate keeps in `g.tipEdges()` the concave edges where
each tip meets the plate, and OpenCascade can't round those together with
the convex tip edges at the same corner: there `fillet(0.3, g.tipEdges())`
fails. Filter them (`g.tipEdges(edge().convex())`) or keep the gear apart
(`.new()`).

**In the editor.** A pick on the feature's geometry is written through its
named buckets first, in declaration order, then the standard ones: a click on
a tooth's tip edge writes `g.tipEdges(…)` (a filter, or an index among its
alternatives), never `g.endEdges(7)`, and a set of picks that exactly fills
one bucket is written as the whole bucket (`g.tipFaces()`; every side face
of the gear, `g.sideFaces()`). Right-clicking a pick offers "Gear Tip Edges
(72)", with the feature's other buckets under *Select other*; the hover reads
"tip edges of Gear"; a pick on a repeat's copy writes
`r.instance(1).tipEdges(…)`.

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
  static id = 'boss';

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

## Example: a spur gear with named buckets

The gear tells its faces apart by the outline edge each one was swept from
(`prism.Generated(edge)`, see [[api/sdk-occt]]), fills the standard buckets
and its own, and derives `tipEdges` and `boreEdges` from their faces:

```feature.js
// gear.feature.js
// A spur gear with straight flanks — a disc of `teeth` trapezoid teeth round
// a shaft bore — standing on a planar face, centred on it. Its tips, flanks,
// roots and bore are named buckets. The outline is raw OpenCascade
// (this.occ()): the curated kernel draws no outline.
import { Feature, defineFeature } from 'fluidcad/sdk';
import { ShapeFactory, ShapeOps } from 'fluidcad/sdk/kernel';
import { Matrix4 } from 'fluidcad/math';

/** The flanks' slant from the tooth's centre line: the old 14.5° rack, which keeps a root land down to ten teeth. */
const FLANK_ANGLE = (14.5 * Math.PI) / 180;

export class Gear extends Feature.with({
  face: { picker: 'face', label: 'On face', surface: 'planar', description: 'The planar face the gear stands on, centred on it' },
  teeth: { type: 'integer', default: 20, min: 10, max: 120, description: 'How many teeth go round the gear' },
  module: { type: 'length', default: 2, min: 0.2, description: 'The tooth size: the pitch diameter over the number of teeth' },
  thickness: { type: 'length', default: 8, min: 0, description: 'How far the gear stands off the face' },
  bore: { type: 'length', default: 8, min: 0, label: 'Bore diameter', description: 'The shaft hole through the middle; 0 leaves it solid' },
}, {
  // What the gear names, in the order the editor tries them.
  buckets: {
    tipFaces: {}, // the top land of every tooth, one per tooth, in tooth order
    tipEdges: {}, // the edges round the tip faces: where a fillet rounds the tooth tips
    flankFaces: {}, // the tooth flanks, two per tooth, in tooth order
    rootFaces: {}, // the bottom land between neighbouring teeth
    boreFaces: {}, // the wall of the shaft hole
    boreEdges: { label: 'Bore Rims' }, // the rims of the shaft hole, top and bottom
  },
}) {
  static id = 'gear';

  buildTool() {
    const faces = this.facesOf(this.values.face);
    if (faces.length !== 1) {
      throw new Error(`gear: pick one planar face to stand on (got ${faces.length} faces)`);
    }
    const plane = faces[0].getPlane();
    const origin = plane.projectPoint(faces[0].center());
    const body = this.occ(scope => Gear.#body(scope, this.values));

    // Placed on the face, centred on it, growing along its normal.
    const all = body.solid.getSubShapes('face');
    const frame = Matrix4.fromBasis(plane.xDirection, plane.yDirection, plane.normal, origin);
    const placed = ShapeOps.transformTracking(body.solid, frame, all);
    body.solid.dispose();
    /** @param {number[]} indices */
    const imagesOf = indices => indices.map(i => placed.images[i]).filter(f => f !== null);
    const tipFaces = imagesOf(body.faces.tip);
    const flankFaces = imagesOf(body.faces.flank);
    const rootFaces = imagesOf(body.faces.root);
    const boreFaces = imagesOf(body.faces.bore);
    this.setBuckets({
      startFaces: imagesOf(body.faces.start),
      endFaces: imagesOf(body.faces.end),
      sideFaces: [...flankFaces, ...tipFaces, ...rootFaces],
      internalFaces: boreFaces,
      tipFaces, flankFaces, rootFaces, boreFaces,
    });
    return [placed.shape];
  }

  /**
   * The gear's outline on the XY plane, extruded along Z: for each tooth, a
   * flank, the tip land, the other flank, then the root land to the next
   * tooth, all on shared vertices so the wire takes the edges as they are.
   * The faces are told apart by the outline edge each one was swept from.
   *
   * @param {import('fluidcad/sdk/occt').OccScope} scope
   * @param {{ teeth: number, module: number, thickness: number, bore: number }} values
   */
  static #body({ oc, track }, { teeth, module, thickness, bore }) {
    const pitch = (module * teeth) / 2;
    const tip = pitch + module;
    const root = pitch - 1.25 * module;
    // Half the tooth's width, across its centre line, at the tip and at the root.
    const tipHalf = (Math.PI * module) / 4 - module * Math.tan(FLANK_ANGLE);
    const rootHalf = (Math.PI * module) / 4 + 1.25 * module * Math.tan(FLANK_ANGLE);
    const step = (2 * Math.PI) / teeth;
    if (step - 2 * Math.asin(rootHalf / root) <= 0) {
      throw new Error(`gear: ${teeth} teeth leave no room between them — give it more teeth`);
    }
    if (bore > 0 && bore / 2 >= root - module) {
      throw new Error(`gear: the bore (${bore}) leaves no rim under the teeth — keep it under ${(2 * (root - module)).toFixed(2)}`);
    }

    /** @param {number} radius @param {number} half @param {number} angle */
    const vertex = (radius, half, angle) => {
      const along = Math.sqrt(radius * radius - half * half);
      const x = along * Math.cos(angle) - half * Math.sin(angle);
      const y = along * Math.sin(angle) + half * Math.cos(angle);
      return track(new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(x, y, 0)).Vertex());
    };
    const axis = new oc.gp_Ax2(new oc.gp_Pnt(0, 0, 0), new oc.gp_Dir(0, 0, 1));
    const tipCircle = new oc.gp_Circ(axis, tip);
    const rootCircle = new oc.gp_Circ(axis, root);

    const corners = Array.from({ length: teeth }, (_, i) => ({
      rootIn: vertex(root, -rootHalf, i * step),
      tipIn: vertex(tip, -tipHalf, i * step),
      tipOut: vertex(tip, tipHalf, i * step),
      rootOut: vertex(root, rootHalf, i * step),
    }));
    const wire = new oc.BRepBuilderAPI_MakeWire();
    /** @type {{ role: 'flank' | 'tip' | 'root', edge: import('fluidcad/sdk/occt').TopoDS_Edge }[]} */
    const roles = [];
    /** @param {'flank' | 'tip' | 'root'} role @param {import('fluidcad/sdk/occt').TopoDS_Edge} edge */
    const add = (role, edge) => {
      wire.Add(track(edge));
      roles.push({ role, edge: track(wire.Edge()) });
    };
    corners.forEach((c, i) => {
      const next = corners[(i + 1) % teeth];
      add('flank', new oc.BRepBuilderAPI_MakeEdge(c.rootIn, c.tipIn).Edge());
      add('tip', new oc.BRepBuilderAPI_MakeEdge(tipCircle, c.tipIn, c.tipOut).Edge());
      add('flank', new oc.BRepBuilderAPI_MakeEdge(c.tipOut, c.rootOut).Edge());
      add('root', new oc.BRepBuilderAPI_MakeEdge(rootCircle, c.rootOut, next.rootIn).Edge());
    });
    if (!wire.IsDone()) {
      throw new Error('gear: the outline did not close');
    }

    const face = new oc.BRepBuilderAPI_MakeFace(track(wire.Wire()), true);
    /** @type {import('fluidcad/sdk/occt').TopoDS_Edge | null} */
    let boreEdge = null;
    if (bore > 0) {
      boreEdge = track(new oc.BRepBuilderAPI_MakeEdge(new oc.gp_Circ(axis, bore / 2)).Edge());
      const boreWire = track(new oc.BRepBuilderAPI_MakeWire(boreEdge).Wire());
      // A hole runs the other way round from the outline.
      face.Add(track(oc.TopoDS.Wire(track(boreWire.Reversed()))));
    }
    const prism = new oc.BRepPrimAPI_MakePrism(track(face.Face()), new oc.gp_Vec(0, 0, thickness), false, true);
    if (!prism.IsDone()) {
      throw new Error('gear: the extrusion failed');
    }

    const solid = ShapeFactory.fromShape(track(prism.Shape()));
    const all = solid.getSubShapes('face');
    /** @param {import('fluidcad/sdk/occt').TopoDS_Shape} raw */
    const indexOf = raw => all.findIndex(f => f.getShape().IsSame(raw));
    /** @param {import('fluidcad/sdk/occt').TopoDS_Edge} edge */
    const sweptFrom = edge => {
      const list = track(prism.Generated(edge));
      /** @type {number[]} */
      const found = [];
      for (; list.Size() > 0; list.RemoveFirst()) {
        const at = indexOf(track(list.First()));
        if (at >= 0) {
          found.push(at);
        }
      }
      return found;
    };
    /** @type {Record<'start' | 'end' | 'tip' | 'flank' | 'root' | 'bore', number[]>} */
    const faces = {
      start: [indexOf(track(prism.FirstShape()))],
      end: [indexOf(track(prism.LastShape()))],
      tip: [],
      flank: [],
      root: [],
      bore: boreEdge ? sweptFrom(boreEdge) : [],
    };
    for (const { role, edge } of roles) {
      faces[role].push(...sweptFrom(edge));
    }
    return { solid, faces };
  }
}

export const gear = defineFeature(Gear, {
  label: 'Gear',
  description: 'A spur gear with straight flanks and a shaft bore, standing on a planar face',
  group: 'create',
  operations: ['add', 'new'],
  call: ['face', { teeth: 'teeth', module: 'module', thickness: 'thickness', bore: 'bore' }],
});
```

A gear pair on a base plate, each gear a body of its own, its tooth tips
rounded through its own bucket:

```fluid.js
import { part, sketch, line, circle, extrude, fillet, chamfer } from "fluidcad/core";
import { coincident, horizontal, vertical, distance, diameter, fix } from "fluidcad/constraints";
import { gear } from "./gear.feature.js";

// A gear pair on a 120 × 70 × 6 base plate: an 18-tooth pinion and a 31-tooth
// wheel, module 2, on round seats 50 mm apart (the sum of their pitch radii,
// 49, and 1 mm of backlash).
export const gearPair = part("Gear pair", () => {
  sketch("xy", () => {
    const b = line([-61, -36], [59, -34]);
    const r = line([59, -34], [61, 36]);
    const t = line([61, 36], [-59, 34]);
    const l = line([-59, 34], [-61, -36]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [-60, -35]);
    distance(b.start(), b.end(), 120);
    distance(r.start(), r.end(), 70);
  });
  extrude(6);

  // The two seats, 2 mm proud of the plate.
  sketch("xy", () => {
    const s = circle([-25, 0], 9);
    fix(s.center(), [-25, 0]);
    diameter(s, 20);
  });
  const pinionSeat = extrude(8);
  sketch("xy", () => {
    const s = circle([25, 0], 14);
    fix(s.center(), [25, 0]);
    diameter(s, 30);
  });
  const wheelSeat = extrude(8);

  // Each gear a body of its own on its seat, its tooth tips rounded.
  const pinion = gear(pinionSeat.endFaces(), { teeth: 18 }).new();
  fillet(0.3, pinion.tipEdges());
  const wheel = gear(wheelSeat.endFaces(), { teeth: 31 }).new();
  fillet(0.3, wheel.tipEdges());
  chamfer(0.5, wheel.boreEdges());
});
```

## Example: a bearing seat, named buckets through a remove

A round pocket built with the curated kernel. It removes by default, so its
named buckets are what the cut leaves: `floorFaces` the seat's floor,
`floorEdges` (declared, not filled) its rim, `wallFaces` the bore. Its
`startPlane` lets the cut classify the mouth as a start edge:

```feature.js
// bearing-seat.feature.js
// A bearing seat: a round pocket sunk into a planar face, centred on it,
// built with the curated kernel. It removes by default.
import { Feature, defineFeature } from 'fluidcad/sdk';
import { Primitives, ShapeOps } from 'fluidcad/sdk/kernel';
import { Matrix4, Plane } from 'fluidcad/math';

export class BearingSeat extends Feature.with({
  face: { picker: 'face', label: 'On face', surface: 'planar' },
  diameter: { type: 'length', default: 22, min: 0 },
  depth: { type: 'length', default: 7, min: 0 },
}, {
  buckets: {
    floorFaces: {}, // the flat bottom the bearing rests on; none when the seat goes right through
    floorEdges: {}, // the rim round the floor, derived from floorFaces
    wallFaces: {}, // the bore the bearing presses into
  },
}) {
  static id = 'bearingSeat';

  buildTool() {
    const { diameter, depth } = this.values;
    const faces = this.facesOf(this.values.face);
    if (faces.length !== 1) {
      throw new Error(`bearing seat: pick one planar face to sink it into (got ${faces.length} faces)`);
    }
    const plane = faces[0].getPlane();
    const origin = plane.projectPoint(faces[0].center());

    // Built on the XY plane from z = 0 to z = depth, its faces sorted there.
    const tool = Primitives.makeCylinder(diameter / 2, depth);
    const all = tool.getSubShapes('face');
    const tolerance = 1e-6 * Math.max(depth, diameter);
    const mouth = all.filter(f => Math.abs(f.getBoundingBox().maxZ) < tolerance);
    const floor = all.filter(f => Math.abs(f.getBoundingBox().minZ - depth) < tolerance);
    const wall = all.filter(f => !mouth.includes(f) && !floor.includes(f));

    // Placed with its Z running into the material: the face's normal reversed.
    const into = plane.normal.negate();
    const frame = Matrix4.fromBasis(plane.xDirection, plane.yDirection.negate(), into, origin);
    const placed = ShapeOps.transformTracking(tool, frame, all);
    tool.dispose();
    const [floorFaces, wallFaces] = [floor, wall]
      .map(group => group.map(f => placed.images[all.indexOf(f)]).filter(f => f !== null));

    this.setBuckets({
      floorFaces,
      wallFaces,
      // The cut classifies its own rims from it: the mouth is a start edge.
      startPlane: new Plane(origin, plane.xDirection, into),
    });
    return [placed.shape];
  }
}

export const bearingSeat = defineFeature(BearingSeat, {
  label: 'Bearing seat',
  description: 'A round pocket a bearing presses into, sunk into a planar face',
  group: 'modify',
  operations: ['remove', 'new'],
  call: ['face', { diameter: 'diameter', depth: 'depth' }],
});
```

```fluid.js
import { part, sketch, line, extrude, fillet, chamfer } from "fluidcad/core";
import { coincident, horizontal, vertical, distance, fix } from "fluidcad/constraints";
import { bearingSeat } from "./bearing-seat.feature.js";

// A 60 × 40 × 12 bearing plate with a seat for a 608 bearing (Ø22 × 7).
export const bearingPlate = part("Bearing plate", () => {
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
  const plate = extrude(12);

  const seat = bearingSeat(plate.endFaces(), { diameter: 22, depth: 7 });
  fillet(0.3, seat.floorEdges());      // a relief where the floor meets the bore
  chamfer(0.5, seat.startEdges());     // a lead-in at the mouth, a rim the cut classified
});
```

A seat deeper than the plate goes right through: its `floorFaces()` and
`floorEdges()` are empty, and the fillet on them fails its row with
`fillet: the selection resolved to no edges — nothing was filleted.`

See [[api/define-feature]] for the metadata, [[api/feature-params]] for the
values and pickers, [[api/connector]] for connectors and their copies.
