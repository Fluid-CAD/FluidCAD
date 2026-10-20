---
id: api/feature
title: "Feature / Feature.with(params) — the base class of a custom feature"
summary: "The class a custom feature extends, from fluidcad/sdk. Feature.with({ … }, { buckets }) declares its values, typing this.values, and its own named buckets (api/feature-buckets); static id names it. A tool's buildTool(ctx) returns solids the base adds, keeps apart or cuts and moves for a repeat (getOperationMode() reads which); a modifier overrides build(ctx). setBuckets() names startFaces…capFaces (edges derived), startPlane and the declared buckets; shapesOf/facesOf/edgesOf/axisOf/planeOf/frameOf/framesOf/pointOf/isLocation/propertiesOf read the picks — framesOf every placement of a picked hole, propertiesOf a reference's plain data; derive() fixes values from the picks (the dialog locks their rows); ghost(ctx) is the dialog's preview; occ() runs raw OpenCascade."
tags: [api, sdk, custom-feature, type]
symbols: [Feature, FeatureBuckets, FeatureBuildContext]
seeAlso: [concepts/custom-features, api/feature-buckets, api/define-feature, api/feature-params, api/sdk-kernel, api/sdk-occt, api/register-builder, api/connector, api/repeat]
---

# Feature

Imported from `fluidcad/sdk`.

```ts
class MyFeature extends Feature.with(params, { buckets }) {   // params: { [name]: ParamSpec }; the options are optional
  static id = 'myFeature';             // plain: the timeline type and the cache's

  readonly values: ValuesOf<params>;   // frozen; a length is a number, a face pick an ISelection

  // A tool implements:
  buildTool(ctx: FeatureBuildContext): Shape[];
  // A modifier overrides instead:
  build(ctx: FeatureBuildContext): void;
  // Optional — the dialog's preview:
  ghost(ctx: FeatureBuildContext): Shape[] | null;
  // Optional — values fixed from what was picked, ahead of every build and preview:
  derive(): Partial<values> | null | undefined;

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
  framesOf(ref: ISceneObject | ISceneObject[]): Plane[];
  pointOf(ref: ISceneObject): Point;
  isLocation(ref: ISceneObject): boolean;
  propertiesOf(ref: ISceneObject): Readonly<Record<string, unknown>>;
  occ<T>(fn: (scope: OccScope) => T): T;

  // What derive() fixed at the last build or preview, and the row's notices:
  getDerived(): Readonly<Record<string, number | string | boolean>>;
  getWarnings(): readonly string[];
}

type FeatureBuckets = {
  startFaces?: Face[]; endFaces?: Face[]; sideFaces?: Face[]; internalFaces?: Face[]; capFaces?: Face[];
  startEdges?: Edge[]; endEdges?: Edge[]; sideEdges?: Edge[]; internalEdges?: Edge[]; capEdges?: Edge[];
  startPlane?: Plane;
};

// Feature.with()'s optional second argument, FeatureWithOptions: { buckets: { tipFaces: {}, … } } (api/feature-buckets)

// What a model gets from every feature, as from a built-in:
f.startFaces(...)  f.endFaces(...)  f.sideFaces(...)  f.internalFaces(...)  f.capFaces(...)
f.startEdges(...)  f.endEdges(...)  f.sideEdges(...)  f.internalEdges(...)  f.capEdges(...)
f.edges(...)                      // every edge a remove created
f.add()  f.new()  f.remove()  f.scope(...solids)  f.name(label)
// And one method per bucket its class declares:
g.tipFaces(...)  g.tipEdges(...)  // r.instance(k).tipEdges(...) on a repeat's copy
```

`Shape`, `Face`, `Edge` come from `fluidcad/sdk/kernel` ([[api/sdk-kernel]]);
`Axis`, `Plane`, `Point` from `fluidcad/math`. The accessors take indices and
filters as `extrude()`'s do: `f.endEdges(0)`, `f.sideFaces(face().cylinder())`.

## Declaring the values: `Feature.with(params)`

`Feature.with({ … })` returns an abstract base whose `this.values` is typed
from `params`, carried as `static params` for `defineFeature()`. Each value
is typed in (`type`) or picked (`picker`): every kind and option is in
[[api/feature-params]]. The optional second argument declares named buckets
(below).

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
default is `false`, a select without one its first option: neither is
`| undefined` unless the select is optional. Every declared name is present
in `this.values`, so the cache's key set never depends on how the call was
written.

`static id` is required: a plain name of letters, digits, `-` and `_`,
starting with a letter (`'standoff'`); dotted names (`'acme.standoff'`) are
accepted too, but not one of the engine's own scene types (`extrude`,
`fillet`, `part`, `sketch`, `distance`, …): "'extrude' is one of the
engine's own types: give the feature another id". `getType()` answers the
id, keyed by the package for a class an installed package defines
(`@acme/mounting-hardware:standoff`); models never write that key. A class
declares **no constructor**: the framework constructs a feature from its
values alone, and a repeat's copy is the same class built from the same
values.

## Tool kind: `buildTool(ctx)`

Return the solids the feature adds or cuts, built where its references stand
now. Then the base:

1. applies the operation the statement chose (`.add()` fuses into the
   solids in scope, `.new()` keeps the solids apart, `.remove()` cuts) or,
   with no chain, the feature's default (`add` when its metadata offers it,
   else the first operation it lists);
2. narrows the solids to `.scope(...)`'s, when given;
3. records the history, and carries the buckets `setBuckets()` named
   across the fusion.

A `repeat()`'s copy builds the tool again from the same references, read
where they stand, and moves it: the references are never copied (copying
the face a standoff stands on would copy the plate with it), and the buckets
move with the tool. `copy()` duplicates the finished solid. Returning no
shape fails the row: `standoff: buildTool() returned no shapes`.

`ctx` is the scene before the feature: `ctx.getSceneObjects()` lists the
objects in scope. A tool rarely needs it.

**Reading the operation: `this.getOperationMode()`** returns `'add'`,
`'new'` or `'remove'`, what the base applies to what `buildTool()` returns:
the statement's chain, else the feature's default (never null; a feature
that declares no `operations` reads `'add'` unless a chain says otherwise).
It reads the same in `buildTool()`, in the dialog's preview (the tab the
dialog shows, the default for a feature without tabs) and on every
`repeat()` copy (its statement's). A chain the feature doesn't offer fails
the row before `buildTool()` runs. Typed `'add' | 'new' | 'remove'` under
checkJs, so a misspelt `'cut'` is flagged. Read it when a remove means a
different tool (an internal gear adds the whole ring but removes only the
tooth space): `if (this.getOperationMode() === 'remove') { return [space]; }`;
a tube that cuts only its bore is [[api/feature-example-tube]].

## Naming the buckets: `setBuckets(buckets)`

Downstream features and the editor's picks name the feature's faces and
edges through its accessors (`post.endEdges()`, `g.tipEdges()`). A feature
fills only the buckets it names: the standard ones and its declared ones.

- **A tool** names sub-shapes of the solids `buildTool()` returns. The base
  moves them with a repeat's copy and carries them across the fusion.
- **Edge buckets left out are derived** from the face buckets: a start
  face's edges are start edges, and so on (the extrude rule). A declared
  `xEdges` left out is the edges of `xFaces`.
- **`startPlane`** is the plane the tool starts on, its normal pointing the
  way the tool grows. A **remove** keeps none of the tool's standard face
  buckets: the cut classifies what it made, as `cut()` does, its rims as
  start edges (where the tool enters the material) and end edges (its far
  end), its walls as internal faces. Without `startPlane` every rim is
  internal. `f.edges()` lists every edge a remove created. A remove's named
  buckets follow the cut instead ([[api/feature-buckets]]).
- **A modifier** names its final geometry; the buckets land at once.
- Calls accumulate. A value left `undefined` names nothing.

**Refused as the row's build error**, for standard and declared names alike
(the preview shows the same message; `render()` never throws): a name that
is no bucket of the feature (`gear: setBuckets() 'tipFace' is not a bucket
of gear — did you mean tipFaces?`), a value that is not a list, a member of
the wrong kind, a tool's member outside the solids `buildTool()` returned (a
face of the shape before `transformTracking` placed it), a `startPlane` that
is not a `Plane`, anything but an object of buckets by name. A misspelt
bucket fails where it is filled, not later as an empty bucket a fillet finds
nothing in. Every message: [[api/feature-buckets]].

## Named buckets: `Feature.with(params, { buckets })`

When the result has parts with names of their own (a gear's tooth tips, a
pocket's floor), declare the ones a user will fillet, chamfer or sketch on:
each becomes a typed method, read like `endFaces()`, that the editor writes
picks through first.

```js
class Gear extends Feature.with({ /* … values … */ }, {
  buckets: { tipFaces: {}, tipEdges: {}, boreFaces: {}, boreEdges: { label: 'Bore Rims' } },
}) { /* buildTool() fills tipFaces and boreFaces in setBuckets(); the edges derive */ }

fillet(0.3, g.tipEdges());   // in a model
```

A name ends in `Faces` or `Edges`; a declaration holds only an optional
`label` (what each bucket holds goes in the package's `docs/` page). A
fusion drops a face that merges into the stock (`startFaces` and `endFaces`
are re-homed onto it instead), a remove keeps what its cut left. Every rule,
refusal and carry rule: [[api/feature-buckets]].

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
| `framesOf(ref)` | every frame a value stands at: a location's one, a picked feature's placements — a `hole()`'s, one per placement — a list's members' in order |
| `pointOf(ref)` | the world position of a location |
| `isLocation(ref)` | whether an element is a connector, a point or an anchor: how a `['solid', 'connector']` value tells its elements apart |
| `propertiesOf(ref)` | what a reference is, as plain data: `type` and the values its statement set and its build resolved (below) |

`axisOf` refuses anything but an axis value ("… is not an axis — declare the value as an
axis picker"), `planeOf` likewise, `frameOf`/`pointOf` anything but a
location, and `framesOf` a value nothing stands at ("… stands nowhere — a
connector, a point, an anchor, or a feature with placements such as a hole").

**The frame of a location** (`frameOf`): a connector gives its own frame; a
face anchor (`e.endFaces().center()`) the face's normal; a circular edge's
`center()` the circle's axis; an edge's `start()`/`end()` the edge's tangent
there, so a vertex named as an edge's end faces along that edge, not out of
a face; a sketch point its sketch's plane; any other point world Z. All of
them where they stand now: a repeat moves the tool the feature builds there,
not the location.

**The properties of a reference** (`propertiesOf`): the plain data of its
timeline row (what `serialize()` reports, shapes and other objects left
out, a point or a vector as its array), with `type` and `unit` — a `hole()`'s `size`,
`fastener` (`{ type: 'clearance', fit }` or `{ type: 'tapped', pitch }`),
`style` (`{ kind: 'counterbore', … }`, `{ kind: 'countersink', … }`),
`depth`, `tipAngle`, `fasten`, `dimensions` (the numbers it cut with) and
`frames`; a connector's `name` and frame; a custom feature's typed-in values
(those its `derive()` fixed in place of the statement's). Lengths are in
the reference's `unit` (`'mm'`, `'in'`, …), its file's. A preview hands the same properties on its
stand-ins. The engine's row data is the contract: a built-in may publish a
documented set of its own by overriding `describe()`.

**What the feature consumes.** From the feature on, the selections and
sketches it reads leave the screen (the selection an anchor stands on and
the sketch a point is drawn in too), but they stay readable: a repeat's
copies read them again. A referenced solid, feature or connector stays.

## Following a pick: `derive()`

A feature that stands at another feature can take its values from it — a
screw sized by the hole it is picked at, a nut by the rod it is threaded
on. Override `derive()` to return the values to fix, by name; return
nothing (or `null`) to fix none:

```js
class Screw extends Feature.with({
  at: { picker: ['connector', 'point', 'anchor', 'feature'], types: ['hole'], label: 'At' },
  size: { type: 'select', default: 'M5', options: SIZES },
  head: { type: 'radio', default: 'socket', options: HEADS },
  length: { type: 'length', default: 16 },
}) {
  static id = 'screw';

  derive() {
    const hole = this.propertiesOf(this.values.at);
    if (hole.type !== 'hole') return null;          // at a connector or a point: nothing fixed
    return { size: hole.size, ...(hole.style?.kind === 'countersink' ? { head: 'flat' } : {}) };
  }

  buildTool() {
    // One screw per placement of the hole; this.values.size is the hole's.
    return this.framesOf(this.values.at).map(frame => screwAt(frame, this.values));
  }
}
```

- It runs **ahead of every build and preview**, once the references are
  built, so `propertiesOf()` and `framesOf()` read them as they stand. What
  it returns replaces the statement's values in `this.values`; a value the
  statement passes as well is ignored, with a **warning on the row**
  (`'size' is "M6", fixed by what the feature was picked at — the statement's
  "M5" is ignored`). `getDerived()` and `getWarnings()` read both back;
  `serialize()` carries them as `derived` and `warnings`.
- It names **typed-in values** of the class only, and each is checked
  against its declaration as a call's would be: `'size' must be one of
  "M5", "M6", got 'M99'` fails the row. A picked value, an unknown name, a
  list or anything but a plain object fails it too.
- Keep it **pure**: the same references give the same values. The cache
  compares the references themselves, so a hole that changes size rebuilds
  the screw.
- **In the dialog**, the preview reports what was fixed and the rows of
  those values show it **locked**, with the note "Fixed by what was picked";
  the statement never writes them, and an edit drops a value it wrote when
  the builder can do without it. Rows that depend on a fixed value
  (`visibleWhen`) follow it. A feature that draws no preview, or whose
  Preview toggle is off, locks nothing — the engine still fixes the values
  when the statement builds.

## The preview: `ghost(ctx)`

While the dialog previews, the engine builds the feature from the
dialog's values on stand-ins of the picks and draws what `ghost()` returns
(green for an add or a new, red for a remove), again on every change. The
scene is never changed.

- **The feature chooses when** (`ghost` in [[api/define-feature]]):
  - `'toggle'`, the default (also `true`, or left out): a **Preview** toggle
    that starts off; until the user turns it on, the engine runs neither
    `ghost()` nor `buildTool()` for the dialog. The page remembers it per
    feature id (turned on, it opens on; turning it off forgets it). For a
    build that may be slow — a gear, a loft through many sections.
  - `'always'`: no toggle; the dialog previews from the start, on every
    change. For a cheap build.
  - `false`: no preview, no toggle.

  Apply never depends on the preview.
- **A tool** previews by default (`ghost()` runs `buildTool()`); override it
  to return something cheaper. **A modifier** draws nothing unless it
  overrides `ghost()`, which may return solids, faces (drawn as patches) or
  edges.
- The preview frees every shape `ghost()` returns once drawn, except one the
  scene itself holds: return shapes built here.
- **Time-out:** a preview over 5 s to build and mesh is not drawn, and the
  dialog asks for no more: "Preview timed out. It took 6.2 s to build, over
  the 5 s a preview may take. Turn it off and on to try again." Turning the
  toggle off and on — or, for a feature that always previews, the row's
  **Try again** — saving the feature's module or opening the dialog again
  asks again.

## Modifier kind: `build(ctx)`

A modifier overrides `build(ctx)` and changes the scene's solids directly,
as `fillet()` does; `draft()` is the engine's own modifier on this base. It
declares no `operations` (its `build()` decides what it does), and a
repeat's copy rebuilds it from copies of its references. `build()` reaches
the solids through the build context and the scene objects' own methods
(`ctx.getSceneObjects()`, `obj.getShapes(…)`, `owner.removeShape(old, this,
[replacement])`, `this.addShapes(…)`): the engine's internals, not a settled
SDK surface. Prefer the tool kind whenever the feature adds or removes
material.

## The cache

Two statements match when their ids and their values match (scalars by
value, references by their own comparison), so a forgotten field can never
serve stale geometry, and there is nothing to write by hand. The class is never
compared: the module is evaluated anew on every render, so the same feature
arrives as a new class each time. **Never `instanceof` your own class**
(`instanceof Feature` is fine). Saving the module's code rebuilds its
statements (see [[concepts/custom-features]]).

## Worked examples

- [[api/feature-example-tube]]: a remove that cuts only the bore.
- [[api/feature-example-bosses]]: bosses at connectors and sketch points (a
  union picker, `frameOf()`, several tools from one statement).
- [[api/feature-example-gear]]: named buckets on a raw OpenCascade outline.
- [[api/feature-example-bearing-seat]]: named buckets through a remove.

See [[api/define-feature]] for the metadata, [[api/feature-params]] for the
values and pickers, [[api/connector]] for connectors and their copies.
