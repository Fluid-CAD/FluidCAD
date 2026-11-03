---
id: api/generator
title: "Generator — a sub-assembly made by code: Generator.with(params), layout(g), static build(type, inputs, ctx)"
summary: "The base class of a generated assembly, from fluidcad/sdk. Generator.with({ … }) declares typed-in values as Feature.with() does (pickers refused) and types this.values; static id names it. layout(g) is plain synchronous JavaScript run for every insert and preview tick: g.part(type, { name, inputs, connectors, appearance, material }) adds a part (a handle with .grounded(), .pose({ position, rotation }), .name(), .connectors.<name>), g.mate(type, a, b) a joint with mate()'s builder (.flip(), .rotate(), .offset(), .limits(), .name()), g.relation(type, a, b, ratio) a coupling; its return value is occurrence.parts. static build(type, inputs, ctx) builds one part template's shapes at render time from its plain-JSON inputs only (ctx.detail 'preview' | 'full', ctx.unit, ctx.occ). Templates with equal type, inputs, connectors, appearance and material are one part, built once; builds are cached across renders by identity, units, detail and code version, so a value dragged back builds nothing. Connector frames are plain JSON { origin, z, x? } in the part's coordinates; every length is the generator's unit and is converted. A throw from layout is the insert's build error, from build that part's."
tags: [api, sdk, custom-feature, generated, assembly, mate, type]
symbols: [Generator, GeneratorWith, GeneratorParams, GeneratorLayout, GeneratedInstance, GeneratedMateBuilder, GeneratedPartSpec, GeneratedPose, GeneratorBuildContext, GeneratorDetail, GeneratedFrameSpec, JsonValue, JsonVector]
seeAlso: [api/define-assembly, api/define-part, api/feature-params, api/mate, api/relation, api/insert, api/sdk-kernel, api/sdk-occt, concepts/assemblies, concepts/custom-features]
---

# Generator

Imported from `fluidcad/sdk`. A generator class becomes insertable through
`defineAssembly()` ([[api/define-assembly]]).

```ts
class MyGenerator extends Generator.with(params) {      // params: GeneratorParams — typed-in values only
  static id = 'wardrobe-unit';                          // dot-separated names of letters, digits, '-', '_'
  readonly values: ValuesOf<params>;                    // the insert's values by id, defaults filled, frozen
  layout(g: GeneratorLayout): R;                        // plain JS, synchronous; R becomes occurrence.parts
  static build(type: string, inputs: JsonValue, ctx: GeneratorBuildContext): Shape[];   // one part template
}
type GeneratorParams = { readonly [id: string]: ScalarParamSpec };   // as Feature.with()'s (api/feature-params), no pickers
type GeneratorWith<P> = abstract Generator class typed by P, carrying `static params: P`;   // what Generator.with(P) returns

class GeneratorLayout {                                 // g
  part(type: string, spec?: GeneratedPartSpec): GeneratedInstance;
  mate(type: 'fastened' | 'revolute' | 'slider' | 'cylindrical' | 'planar', a: ConnectorSide, b: ConnectorSide): GeneratedMateBuilder;
  relation(type: 'gear' | 'rack-and-pinion', a: GeneratedMateBuilder, b: GeneratedMateBuilder, ratio: number): RelationBuilder;
}
type GeneratedPartSpec = {
  name?: string;                                        // the instance's row name; the type when left out
  inputs?: JsonValue;                                   // all build() reads besides the type; {} when left out
  connectors?: { [name: string]: GeneratedFrameSpec };  // frames in the part's own coordinates
  appearance?: string;                                  // 'oak', 'steel', … as part().appearance() takes
  material?: string;                                    // as part().material() takes
};
type GeneratedFrameSpec = { origin: JsonVector; z: JsonVector; x?: JsonVector };
type JsonVector = [number, number, number];
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };   // finite numbers

class GeneratedInstance extends Instance {              // what g.part() returns
  connectors: { [name: string]: ConnectorSide };        // for g.mate(), and the inserting assembly's mate()
  grounded(): this;                                     // fixed in the generated assembly's frame
  pose(pose: GeneratedPose): this;                      // the starting pose
  name(name: string): this;
  translate(x: number, y?: number, z?: number): this;  rotate(axis: AxisLike, degrees: number): this;
}
type GeneratedPose = { position?: [number, number, number]; rotation?: [number, number, number] };   // degrees: X, then Y, then Z

class GeneratedMateBuilder extends MateBuilder {        // what g.mate() returns: mate()'s builder (api/mate)
  flip(): this;  rotate(degrees: number): this;  offset(x: number, y?: number, z?: number): this;
  limits(min: number, max: number): this;  name(name: string): this;
}

type GeneratorBuildContext = {
  readonly detail: GeneratorDetail;                     // how much to build
  readonly unit: LengthUnit;                            // the generator's unit: its defining module's
  occ<T>(fn: (scope: OccScope) => T): T;                // raw OpenCascade, as a feature's this.occ() (api/sdk-occt)
};
type GeneratorDetail = 'preview' | 'full';
```

A generator makes a sub-assembly from one object of values: its parts,
their connectors, their starting poses and the joints between them. It
runs in two phases:

- **`layout(g)`** runs for every insert, while the assembly module
  evaluates, and on every tick of the dialog's preview. It reads
  `this.values` and declares parts with `g.part()`, joints with `g.mate()`
  and couplings with `g.relation()`. Plain JavaScript: no geometry is built
  here.
- **`static build(type, inputs, ctx)`** runs at render time, once for each
  part template the engine doesn't already hold built, and returns the
  part's shapes. Being static it reads only the type and the inputs, so
  whatever changes a part's geometry has to be in its inputs. That is what
  lets the engine cache builds.

## Example: a wardrobe

A carcass, grounded; two doors on hinges above a stack of drawers on
runners. The doors are mirror images, so they are two templates; the
drawers are equal, so they are one template built once. While a value is
being dragged, the doors skip their hinge-cup drilling.

```js
// features/wardrobe-unit.js
import { Generator } from 'fluidcad/sdk';
import { BooleanOps, Primitives, ShapeFactory, ShapeOps } from 'fluidcad/sdk/kernel';
import { Matrix4, Point, Vector3d } from 'fluidcad/math';

const BOARD = 18;                                    // board thickness, mm

export class WardrobeUnit extends Generator.with({
  width: { type: 'length', default: 1000, min: 600, max: 2400 },
  height: { type: 'length', default: 2000, min: 1200, max: 2600 },
  depth: { type: 'length', default: 580, min: 400, max: 700 },
  drawers: { type: 'integer', display: 'stepper', default: 2, min: 0, max: 4 },
  drawerHeight: { type: 'length', default: 200, min: 120, max: 300, label: 'Drawer height' },
  hingeAngle: { type: 'angle', default: 110, min: 90, max: 170, label: 'Door swing' },
  doorsOpen: { type: 'angle', default: 0, min: 0, max: 170, label: 'Doors open' },
}) {
  static id = 'wardrobe-unit';

  layout(g) {
    const { width, height, depth, drawers, drawerHeight, hingeAngle, doorsOpen } = this.values;
    const doorBottom = BOARD + drawers * drawerHeight;
    if (height - doorBottom < 600) {
      throw new Error(`${drawers} drawers of ${drawerHeight} leave less than 600 for the doors of a wardrobe ${height} high`);
    }
    const travel = Math.min(500, depth - 80);

    // Each hinge and each runner is a frame on the carcass and the same frame
    // on the part it carries, so the part sits closed at the joint's 0.
    const hinge = (x, swing) => ({ origin: [x, -BOARD, doorBottom], z: [0, 0, swing], x: [-swing, 0, 0] });
    const runner = i => ({ origin: [0, 0, BOARD + i * drawerHeight], z: [0, -1, 0], x: [1, 0, 0] });
    const runners = Object.fromEntries(Array.from({ length: drawers }, (_, i) => [`drawer${i + 1}`, runner(i)]));

    const carcass = g.part('carcass', {
      name: 'Carcass',
      inputs: { width, height, depth },
      connectors: {
        top: { origin: [width / 2, depth / 2, height], z: [0, 0, 1] },   // for what stands on it
        leftHinge: hinge(0, -1),
        rightHinge: hinge(width, 1),
        ...runners,
      },
      appearance: 'oak',
    }).grounded();

    // The doors are mirror images: their inputs differ, so two templates.
    const door = (side, x, swing) => g.part('door', {
      name: side === 'left' ? 'Left door' : 'Right door',
      inputs: { width: width / 2 - 2, height: height - doorBottom, hingeSide: side },
      connectors: { hinge: { origin: [0, 0, 0], z: [0, 0, swing], x: [-swing, 0, 0] } },
      appearance: 'oak',
    }).pose({ position: [x, -BOARD, doorBottom], rotation: [0, 0, swing * Math.min(doorsOpen, hingeAngle)] });
    const left = door('left', 0, -1);
    const right = door('right', width, 1);
    g.mate('revolute', carcass.connectors.leftHinge, left.connectors.hinge).flip().limits(0, hingeAngle).name('Left door');
    g.mate('revolute', carcass.connectors.rightHinge, right.connectors.hinge).flip().limits(0, hingeAngle).name('Right door');

    // Equal drawers: equal inputs and connectors, one template, built once.
    const drawerParts = [];
    for (let i = 0; i < drawers; i++) {
      const drawer = g.part('drawer', {
        name: `Drawer ${i + 1}`,
        inputs: { width, height: drawerHeight - 3, depth: depth - BOARD - 40 },
        connectors: { slide: { origin: [0, 0, 0], z: [0, -1, 0], x: [1, 0, 0] } },
        appearance: 'oak',
      }).pose({ position: [0, 0, BOARD + i * drawerHeight] });
      g.mate('slider', carcass.connectors[`drawer${i + 1}`], drawer.connectors.slide).flip().limits(0, travel).name(`Drawer ${i + 1}`);
      drawerParts.push(drawer);
    }
    return { carcass, doors: { left, right }, drawers: drawerParts };
  }

  static build(type, inputs, ctx) {
    const { width, height, depth } = inputs;
    if (type === 'carcass') {
      // Sides, top, bottom and back: a box with its front open.
      return [WardrobeUnit.cut(
        WardrobeUnit.box(ctx, [0, 0, 0], [width, depth, height]),
        WardrobeUnit.box(ctx, [BOARD, -1, BOARD], [width - BOARD, depth - BOARD, height - BOARD]),
      )];
    }
    if (type === 'door') {
      // Built from its hinge, across +x for a left door, -x for a right one.
      const across = inputs.hingeSide === 'left' ? 1 : -1;
      const slab = WardrobeUnit.box(ctx, [0, 0, 0], [across * width, BOARD, height]);
      if (ctx.detail === 'preview') {
        return [slab];                             // no drilling while a value is being dragged
      }
      // Two Ø35 hinge cups, 13 deep, from the inside face, 22.5 from the hinged edge.
      let door = slab;
      for (const z of [100, height - 100]) {
        const cup = ShapeOps.transform(Primitives.makeCylinder(17.5, 13), Matrix4.fromBasis(
          new Vector3d(1, 0, 0), new Vector3d(0, 0, -1), new Vector3d(0, 1, 0), new Point(across * 22.5, BOARD - 13, z)));
        door = WardrobeUnit.cut(door, cup);
      }
      return [door];
    }
    if (type === 'drawer') {
      // Its front, and a tray behind it between the runners.
      const front = WardrobeUnit.box(ctx, [0, -BOARD, 0], [width, 0, height]);
      const tray = WardrobeUnit.cut(
        WardrobeUnit.box(ctx, [BOARD + 13, 0, 20], [width - BOARD - 13, depth, height - 30]),
        WardrobeUnit.box(ctx, [BOARD + 25, 12, 32], [width - BOARD - 25, depth - 12, height]),
      );
      return [front, tray];
    }
    throw new Error(`no part of type '${type}'`);
  }

  /** A box between two corners. */
  static box(ctx, lo, hi) {
    return ctx.occ(({ oc, track }) => ShapeFactory.fromShape(track(
      new oc.BRepPrimAPI_MakeBox(new oc.gp_Pnt(lo[0], lo[1], lo[2]), new oc.gp_Pnt(hi[0], hi[1], hi[2])).Shape())));
  }

  /** `shape` less `tool`; both inputs are let go. */
  static cut(shape, tool) {
    const result = BooleanOps.cutShapes(shape, tool);
    shape.dispose();
    tool.dispose();
    return result;
  }
}
```

`insert(wardrobe, { drawers: 3 })` (the definition: [[api/define-assembly]])
gives six instances — Carcass (grounded), Left door, Right door, Drawer 1–3 —
from four templates, five joints named after their parts, and
`occurrence.parts` = `{ carcass, doors: { left, right }, drawers: [ … ] }`.
`doorsOpen` only sets where the doors start: changing it builds nothing.

## Declaring the values: `Generator.with(params)`

- **The same declarations as `Feature.with()`** ([[api/feature-params]]):
  `length`, `angle`, `integer`, `number`, `boolean`, `select`, `radio`,
  `text`, with defaults, ranges, options with pictures, `display`,
  `visibleWhen`, `group`, `tab`, a value's `aside`. They are checked where
  the module loads.
- **Typed-in values only.** A picker is refused: "`Generator.with(): 'face'
  is a picked value — a generator takes typed-in values only (numbers,
  lengths, angles, booleans, selects, radios, texts): the assembly that
  inserts it mates its parts`".
- **`this.values`** holds every declared value, by id, defaults filled,
  frozen. Declare no constructor: the engine constructs the generator from
  the insert's values.
- **`static id`** names the generator, and so the definition and every part
  template it declares. Dot-separated names of letters, digits, `-` and `_`,
  each starting with a letter. An installed package keys it by the package
  (`@fluidcad/cabinets:wardrobe-unit`); a model never writes that key.
- **Option pictures resolve against the module that calls
  `Generator.with()`**: the class's. Keep the class beside its images (a
  package's `features/`), even when its values are spread from a shared
  module (`Generator.with({ ...WARDROBE_VALUES })`).

## `layout(g)`

- **Synchronous plain JavaScript.** It runs on every insert and every
  preview tick: keep it cheap, build no geometry. An async layout is
  refused ("layout(g) runs synchronously — it must not be async").
- **Loops are fine here.** The no-loops rule is for models: a generator's
  parts come from one `insert()` and one dialog.
- **Its return value is `occurrence.parts`**: return the handles the
  inserting assembly may mate to, nested as you like
  (`{ carcass, doors: { left, right }, drawers: [ … ] }`).
- **A throw is the insert's build error.** The occurrence then holds one
  empty part, named after the assembly, whose row carries the message
  (`assembly 'Wardrobe': 4 drawers of 300 leave less than 600 for the doors
  of a wardrobe 1400 high`); nothing else of the layout stays. Throw the
  sentence a user can act on.
- **`g` serves the layout only**: a call after it returned is refused
  ("`g.part(): the layout has returned — g declares parts and joints only
  while layout(g) runs`").
- Every record a layout makes (instances, mates, relations) is located at
  the `insert()` that ran it.

## Parts: `g.part(type, spec)`

Each call adds an instance of a **part template**: its type, inputs,
connectors, appearance and material.

- **Templates are shared by identity.** Two calls that agree on all five are
  one template: one part, built once, both instances showing it — across
  the occurrences of one definition in a scene too. The `name` is each
  instance's own and no part of the identity. A mirror-image door has other
  inputs, so it is another template.
- **`inputs` are plain JSON**: finite numbers, strings, booleans, `null`,
  arrays and plain objects, nested to any depth. They are copied and frozen.
  Anything else is refused, naming where it sits, as the insert's build
  error: "`g.part('door'): inputs.hinge.side is a function — inputs are
  plain JSON: numbers, strings, booleans, null, arrays and plain objects`"
  (also `inputs.list[1] is NaN`, `inputs.lookup is a Map`,
  `inputs["front panel"] is undefined (leave it out, or give null)`).
- **Round computed numbers** you put in inputs (to 6 decimals, say): two
  doors equal on paper but 1e-13 apart are two templates.
- **The template part is named after its type** (`door`): the Parts panel
  lists each instance by its `name` (`Left door`).
- `appearance` and `material` are ids, as `part(…).appearance(id)` and
  `.material(id)` take them: colour fronts apart from the carcass by part.
- A spec field other than the five is refused: "`g.part('door'): unknown
  field 'colour' — the fields are name, inputs, connectors, appearance,
  material`"; so is a type that is not a non-empty string.

### Connectors

`connectors` are frames in the part's own coordinates, in the generator's
unit, each `{ origin: [x, y, z], z: [x, y, z], x?: [x, y, z] }`:

- `z` is the connector's axis, of any length but zero.
- `x` is squared against `z`; it must not run along `z`. Left out, X is the
  one a connector on a plane of that normal takes.
- A name is a plain identifier. On each instance the connector is
  `handle.connectors.<name>`, a side for `g.mate()` and, through
  `occurrence.parts`, for the inserting assembly's `mate()`.
- Refused, as the insert's build error: "`g.part('door'): connectors.hinge:
  'z' has no length — it is the connector's axis`", "`… 'x' runs along 'z' —
  give an X square to the connector's axis, or leave it out`", "`… 'origin'
  must be [x, y, z], three finite numbers — got a list`".

### Poses and grounding

- **`.grounded()`** fixes the part in the generated assembly's frame: a
  carcass needs no joint. The inserting assembly grounds or places the
  occurrence as a whole.
- **`.pose({ position, rotation })`** sets where the part starts: its origin
  at `position` (generator unit), turned by `rotation` in degrees about X,
  then Y, then Z, about the part's origin — as `.rotate('x', a).rotate('y',
  b).rotate('z', c)` turns an inserted part. It is a starting pose, never a
  constraint: the joints decide where a jointed part goes, and the Joints
  panel drives it from there. A value that only sets a pose (`doorsOpen`,
  `drawersOut`) rebuilds no template.
- `.translate()` and `.rotate()` work as on any instance, in the generator's
  unit.
- A bad pose is refused: "`.pose(): 'position' must be [x, y, z], three
  finite numbers — got a list`", "`.pose(): unknown field 'angle' — a pose
  holds position and rotation`".

## Joints: `g.mate()` and `g.relation()`

`g.mate(type, a, b)` makes the same record `mate()` does, in the
occurrence's scope, with the same builder ([[api/mate]]): `.flip()`,
`.rotate(deg)`, `.offset(x, y, z)`, `.limits(min, max)`, `.name(name)`.

- **Name every joint** after what it moves (`.name('Left door')`): the
  Joints panel lists a joint by its name, its type beside it, and animates
  it from there.
- **A frame on both sides.** Give the carcass a connector that is the same
  frame, in the assembly, as the moving part's own connector when closed,
  and `.flip()` the mate: the default face-to-face placement would turn the
  part over. The joint's 0 is then the closed position, and `.limits(0,
  hingeAngle)` or `.limits(0, travel)` read naturally.
- A revolute turns about its Z, positive by the right-hand rule: point a
  door's hinge Z so that a positive turn opens it outward (down, `-Z`, for a
  door hinged on its left; up for one hinged on its right).
- `.limits()`: a revolute's in degrees, a slider's in the generator's unit.
- `g.relation(type, a, b, ratio)` couples two of the layout's joints, as
  `relation()` does ([[api/relation]]): `'gear'` (turns of B per turn of
  A) or `'rack-and-pinion'` (B's travel per turn of A, in the generator's
  unit). Both mates are the layout's.

```js
const leftSwing = g.mate('revolute', carcass.connectors.leftHinge, left.connectors.hinge).flip().limits(0, 110).name('Left door');
const rightSwing = g.mate('revolute', carcass.connectors.rightHinge, right.connectors.hinge).flip().limits(0, 110).name('Right door');
g.relation('gear', leftSwing, rightSwing, 1).name('Doors together');   // both doors open as one
```

## Building a part: `static build(type, inputs, ctx)`

- **Static, so it reads only `type` and `inputs`** — the `inputs` its
  `g.part()` call gave, frozen. Never `this.values`, never module state.
- **Returns the part's shapes**: an array of kernel shapes
  (`fluidcad/sdk/kernel`, [[api/sdk-kernel]]), at the part's own origin, in
  `ctx.unit`. Several solids are fine (a drawer's front and its tray).
  Anything else is the part's build error: "`returned nothing — build
  returns the part's shapes, an array such as [solid]`"; an async build is
  refused ("build runs synchronously — it must not be async").
- **`ctx.occ(fn)`** runs raw OpenCascade in a scope that frees what `fn`
  makes except what it returns, as a feature's `this.occ()` does
  ([[api/sdk-occt]]). The curated kernel has no box: build one there.
- **Dispose what you drop**: a shape a cut consumed, a tool you moved.
  Never dispose a shape you return.
- **A throw is that part's build error**, named after the build:
  "`WardrobeUnit.build('door'): …`". The part holds no shapes; every other
  part builds.
- Handle every type your layout declares, and throw on any other.

### Detail: `ctx.detail`

`'full'` builds every detail. `'preview'` asks for what is quick to make,
while the user is still dragging a control in the dialog: skip drilling,
small hardware and fillets. The render decides: a preview render while a
control moves asks for `'preview'`, every other render (the dialog at rest,
Apply, a saved file, an export) for `'full'`. Each tier is built and cached
apart, so a build may make **less** at `'preview'`, never something else.

## The cache

The engine keeps a template's build across renders, keyed by:

- the template's identity — the definition's id, the type, and the
  canonical JSON of its inputs, connectors, appearance and material (object
  keys sorted, so key order never matters);
- the generator's unit and the inserting assembly's;
- the detail tier;
- the generator's code version: the text of its class chain, its package's
  version when installed, and a count bumped when its defining module, or a
  workspace module that module reaches through its imports, is saved.

So:

- **A changed value rebuilds only the templates whose key changed.** In the
  wardrobe, a new `depth` rebuilds the carcass and the drawer and keeps both
  doors; `doorsOpen` (poses only) builds nothing; a new `drawerHeight`
  rebuilds all four, because it moves the hinge and runner frames — and
  connectors are part of a template's identity.
- **A value dragged back builds nothing**, and neither do Cancel in the
  dialog, an undo or a second occurrence with equal values: the earlier
  builds come back from the cache (bounded: by default 256 builds and an
  estimated 256 MB, least recently used first).
- **Saving the generator's code rebuilds its parts**, with no engine
  restart; so does an edit of a generator written in the open assembly file
  itself, which renders from the editor's buffer.
- A forced recompute clears the cache.
- **Keep no shapes in module state** across renders. A build that hands
  back a shape it cached itself returns a shape the engine may already have
  freed. The engine caches; the generator only builds.

## Units

Every length a generator writes — its values, inputs, connector frames,
poses, mate offsets, slider limits, rack ratios — is in its defining
module's unit (`ctx.unit`): that file's `unit()`, else its project's.
Inserted into an assembly of another unit, its parts are rescaled and its
poses, offsets, slider limits and rack ratios converted. Revolute limits,
`.rotate()` angles and gear ratios are not lengths and stay as written. The
insert's values are not converted: they are the generator's numbers.

## Where things fail

| What went wrong | Where it shows |
|---|---|
| a bad declaration in `Generator.with()`, a picker | the module fails to load: the assembly that imports it fails to compile |
| a bad class or metadata in `defineAssembly()` | the same, with `defineAssembly(<Class>): …` |
| a misspelt id or a refused value in `insert()` | the insert's row: `assembly 'Wardrobe': 'widht' is not one of its values — did you mean 'width'? …` |
| `layout(g)` throws, or a bad `g.part()` spec, frame, pose or non-JSON input | the insert's row, the layout rolled back: `assembly 'Wardrobe': g.part('door'): …` |
| `build` throws or returns no array of shapes | that part's row: `WardrobeUnit.build('door'): …`; the other parts build |

## Where it lives

- The class in a plain module beside its images — a package's `features/`
  (`features/wardrobe-unit.js`); shared layout code in `features/lib/`.
- The definition (`defineAssembly`) exported from an `*.assembly.js`
  module — a package's `assemblies/` ([[api/define-assembly]],
  [[concepts/packages]]). An `*.assembly.js` may export the class too; the
  editor never calls an exported class, and a package's `index.js` never
  re-exports one.
