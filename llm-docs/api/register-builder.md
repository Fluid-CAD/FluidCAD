---
id: api/register-builder
title: "registerBuilder(build, { feature }) / parseCall(meta, args) — the explicit path"
summary: "The explicit way to make a custom feature's builder, from fluidcad/sdk: a plain Feature subclass, the whole metadata object (class, kind and params included) passed to registerBuilder(build, { feature }), and parseCall(meta, args) to read the call's arguments into the feature's values. It builds exactly what defineFeature() builds; use it when the builder must do something before reading its arguments. The metadata is checked at registration; it refuses a buckets field (a plain subclass declares static buckets, untyped)."
tags: [api, sdk, custom-feature, metadata, type]
symbols: [registerBuilder, parseCall, FeatureMeta]
seeAlso: [api/define-feature, api/feature, api/feature-buckets, api/feature-params, concepts/custom-features]
---

# registerBuilder / parseCall

Imported from `fluidcad/sdk`.

```ts
registerBuilder(
  build: (context: SceneParserContext) => (...args) => Feature,
  options: { feature: FeatureMeta },
): (...args) => Feature

parseCall(meta: FeatureMeta, args: ArrayLike<unknown>): FeatureValues   // checked, defaults filled
parseCall(shape: CallShape, args: ArrayLike<unknown>): FeatureValues    // read by the shape only

type FeatureMeta = {
  class: FeatureClass;                         // extends Feature; its static id is the feature's id
  kind: 'tool' | 'modifier';                   // must match the class
  params: { [name: string]: ParamSpec };       // what Feature.with() declares on the other path
  label: string; description?: string; icon?: string; group: 'create' | 'modify';
  operations?: ('add' | 'new' | 'remove')[]; call: CallShape; ghost?: boolean; contexts?: ['part'];
};
```

`defineFeature(Class, meta)` (see [[api/define-feature]]) is this path with
the class's own values and kind filled in, and it types the builder for the
editor. Reach for `registerBuilder` when the builder must act before it reads
its arguments — the engine's own `draft()` takes the last selection there
when it is called with an angle alone.

- **`registerBuilder(build, { feature })`** checks the metadata when the
  module loads (the same checks and messages as `defineFeature()`, and
  `kind` must match the class: a tool leaves `build()` to the base and
  implements `buildTool()`), and returns the builder carrying it. `build` is
  called with the scene's context for each call and returns the function
  that makes the feature. The builder captures the call's source location
  itself, so the statement's row points at the model's line.
- **`parseCall(meta, args)`** reads the arguments by `meta.call`, checks each
  value against `meta.params` (types, `min`/`max`, select options, required
  values), fills defaults, turns one scene object passed for a list into a
  list of one, and returns **every** declared name (`undefined` for one left
  out). Its refusals name the builder: `standoff(): 'height' must be a
  number, got a function`.
- **`feature.addTo(context)`** adds the feature to the scene after any
  reference written inline in the call (`e.endFaces()` exists for this call
  alone and must build first), and returns the feature for the builder to
  return.
- `allowAssemblyTopLevel` is refused with `feature`: a feature runs where its
  `contexts` say.
- **Buckets are declared on the class, never in the metadata.** A `buckets`
  field is refused: `feature metadata: leave 'buckets' out — declare buckets
  on the class: Feature.with(params, { buckets }), or static buckets on a
  plain Feature subclass`. A plain subclass declares `static buckets = {
  boreFaces: {}, boreEdges: {} }`; `registerBuilder` checks the declaration
  as `Feature.with()` does and installs the accessors (`post.boreEdges()`),
  which exist at run time only: the types don't carry them, so under checkJs
  `post.boreEdges()` and `this.setBuckets({ boreFaces })` are flagged. For
  typed named buckets, use `Feature.with(params, { buckets })` (see
  [[api/feature-buckets]]).

In plain JavaScript, a plain `Feature` subclass's `this.values` is untyped;
declare it with JSDoc, as below, or prefer `Feature.with()` and
`defineFeature()`, which type it by inference.

## Example: the standoff, the explicit way

The same standoff as [[concepts/custom-features]], built from the whole
metadata:

```feature.js
// standoff.feature.js
/** @import { FeatureMeta, ISelection } from 'fluidcad/sdk' */
import { Feature, parseCall, registerBuilder } from 'fluidcad/sdk';
import { BooleanOps, Primitives, ShapeOps } from 'fluidcad/sdk/kernel';
import { Matrix4, Plane } from 'fluidcad/math';

/** @typedef {{ face: ISelection, height: number, outer: number, hole: number }} StandoffValues */

/** @extends {Feature<StandoffValues>} */
export class Standoff extends Feature {
  static id = 'standoff';

  buildTool() {
    const { height, outer, hole } = this.values;
    if (!(hole < outer)) {
      throw new Error(`standoff: the hole (${hole}) must be narrower than the boss (${outer})`);
    }
    const faces = this.facesOf(this.values.face);
    if (faces.length !== 1) {
      throw new Error(`standoff: pick one planar face to stand on (got ${faces.length} faces)`);
    }
    const plane = faces[0].getPlane();
    const origin = plane.projectPoint(faces[0].center());

    const boss = Primitives.makeCylinder(outer / 2, height);
    const bore = Primitives.makeCylinder(hole / 2, height);
    const tube = BooleanOps.cutShapes(boss, bore);
    boss.dispose();
    bore.dispose();

    const tolerance = 1e-6 * Math.max(height, outer);
    const all = tube.getSubShapes('face');
    const start = all.filter(f => Math.abs(f.getBoundingBox().maxZ) < tolerance);
    const end = all.filter(f => Math.abs(f.getBoundingBox().minZ - height) < tolerance);
    const walls = all.filter(f => !start.includes(f) && !end.includes(f));
    const side = walls.filter(f => f.getBoundingBox().maxX > hole / 2 + tolerance);
    const internal = walls.filter(f => !side.includes(f));

    const frame = Matrix4.fromBasis(plane.xDirection, plane.yDirection, plane.normal, origin);
    const placed = ShapeOps.transformTracking(tube, frame, all);
    tube.dispose();
    const [startFaces, endFaces, sideFaces, internalFaces] = [start, end, side, internal]
      .map(group => group.map(f => placed.images[all.indexOf(f)]).filter(f => f !== null));

    this.setBuckets({
      startFaces,
      endFaces,
      sideFaces,
      internalFaces,
      startPlane: new Plane(origin, plane.xDirection, plane.normal),
    });
    return [placed.shape];
  }
}

/** @type {FeatureMeta} */
const meta = {
  class: Standoff,
  kind: 'tool',
  label: 'Standoff',
  description: 'A boss with a bore through it, standing on a planar face',
  group: 'create',
  operations: ['add', 'new'],
  params: {
    face: { picker: 'face', label: 'On face', surface: 'planar' },
    height: { type: 'length', default: 10, min: 0 },
    outer: { type: 'length', default: 6, min: 0, label: 'Boss diameter' },
    hole: { type: 'length', default: 3, min: 0, label: 'Hole diameter' },
  },
  call: ['face', { height: 'height', outer: 'outer', hole: 'hole' }],
};

export const standoff = registerBuilder(
  context => /** @param {...unknown} args */ (...args) =>
    new Standoff(/** @type {StandoffValues} */ (parseCall(meta, args))).addTo(context),
  { feature: meta },
);
```

The builder's arguments are not typed on this path (`...args: unknown[]`), so
the editor can't mark a wrong call; the builder still refuses one at run
time.

```fluid.js
import { part, sketch, circle, extrude, fillet } from "fluidcad/core";
import { diameter, fix } from "fluidcad/constraints";
import { standoff } from "./standoff.feature.js";

// A round sensor mount: a Ø40 × 4 disc with a standoff in the middle.
export const sensorMount = part("Sensor mount", () => {
  sketch("xy", () => {
    const rim = circle([0, 0], 20);
    fix(rim.center(), [0, 0]);
    diameter(rim, 40);
  });
  const disc = extrude(4);
  const post = standoff(disc.endFaces(), { height: 15, hole: 2.5 });
  fillet(1, post.startEdges());
});
```
