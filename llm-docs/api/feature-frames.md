---
id: api/feature-frames
title: "Named frames — Feature.with(params, { frames }), setFrames(), frame(name): where a custom feature stands"
summary: "A custom feature declares named coordinate frames in Feature.with()'s second argument, { frames: { axis: { label: 'Gear axis' } } }, and sets each in its build with this.setFrames({ axis: plane }) (a Plane: origin, X direction, normal). A model reads one back as a plane reference with g.frame('axis') — a connector() source in a part body (connector('axis', g.frame('axis'))) and a plane() input — and r.instance(k).frame('axis') on a repeat's copy. A generated part (definePart) turns every declared frame into a connector of its name (insert(gearPart).connectors.axis). Declaration rules (identifier names, at most 16, only a label), every refusal and where it shows, how a repeat moves frames, and a runnable bushing example."
tags: [api, sdk, custom-feature, frames, connector, type]
symbols: [FeatureFrameSpec, FeatureFrameSpecs, NamedFrames]
seeAlso: [api/feature, api/feature-buckets, api/define-part, api/connector, api/plane, api/repeat, concepts/custom-features]
---

# Named frames

Declared on the class that extends `Feature.with()` from `fluidcad/sdk`
(the class itself: [[api/feature]]).

```ts
// Feature.with(params, options)'s second argument (FeatureWithOptions):
{ buckets?: FeatureBucketSpecs; frames?: FeatureFrameSpecs }
type FeatureFrameSpecs = { [name: string]: FeatureFrameSpec };   // name: an identifier, at most 48 characters; at most 16 frames
type FeatureFrameSpec = { label?: string };                       // what the editor calls it; nothing else

// In the build (buildTool() or a modifier's build()):
this.setFrames(frames: NamedFrames<declared names>): void
type NamedFrames<F> = { [K in F]?: Plane };                       // Plane from fluidcad/math: origin, xDirection, normal (Z)

// In a model, on the feature's statement:
g.frame(name): IPlane                // a plane reference: a connector() source and a plane() input
r.instance(k).frame(name)            // the same frame on a repeat's copy k

// A generated part makes each frame a connector of its name (api/define-part):
insert(gearPart).connectors.axis
```

A frame says where the feature stands: a gear's axis, a bracket's mounting
face, a rack's pitch line. Buckets ([[api/feature-buckets]]) name faces and
edges a user fillets or sketches on; a frame is a coordinate frame a user
mates to. Declare one when a part built from the feature needs a connector
there.

## Declaring

```js
export class Gear extends Feature.with({ /* … values … */ }, {
  frames: { axis: { label: 'Gear axis' } },   // origin on the axis, Z up it, X the phase reference
}) { … }
```

- **The name is an identifier** (`axis`, `mountFace`): it becomes a
  connector's name. At most 48 characters, at most 16 frames a class.
- **A declaration is `{}` or `{ label }`.** `label` is what the editor calls
  the frame; left out, the name made readable (`mountFace` → "Mount face").
  Describe what the frame is (where its origin sits, which way Z and X
  point) in the package's `docs/` page for the feature, as for a bucket.
- A plain `Feature` subclass declares them as `static frames = { … }`.
- **Not in the metadata.** `defineFeature()` and `registerBuilder` refuse a
  `frames` field: "leave 'frames' out — declare frames on the class:
  Feature.with(params, { frames })".

The declarations are checked where the module loads:

| Declaration | Message |
|---|---|
| a name that is not an identifier | `Feature.with(): the frame name 'mount-face' is not an identifier — a frame becomes a connector of its name, such as axis or mountFace` |
| a declaration that is not an object | `Feature.with(): frame 'axis' is declared with an object — {} or { label } — got true` |
| a field other than `label` | `Feature.with(): frame 'axis': unknown field 'normal' — a frame declares only its label` |
| `frames` not an object | `Feature.with(): 'frames' must be an object of the feature's frames by name, such as { axis: {}, mount: { label: 'Mounting face' } } — got a list` |

## Setting: `this.setFrames({ name: plane })`

- **Each value is a `Plane`** (`fluidcad/math`): `origin`, `xDirection` and
  `normal`, the frame's Z. Set it where the feature stands in the model, as
  the solids are placed.
- **A tool** sets its frames for the solids `buildTool()` returns, and the
  base moves them with a repeat's copy as it moves the solids. **A modifier**
  sets them where its `build()` leaves them.
- **Calls accumulate**; a later plane of one name replaces the earlier one.
  Every build starts with no frames set.
- **Refused as the feature's build error** (its row fails): a name the class
  doesn't declare, "`gear: setFrames() 'axle' is not a frame of the feature —
  its frames are axis`", and a value that is not a plane, "`gear: setFrames()
  axis must be a plane (a Plane: origin, X direction and normal), got an
  object`".

## Reading: `g.frame(name)`

`frame(name)` returns a reference that builds after the feature and holds
the frame where the build set it. It draws nothing and has no timeline row
of its own: it stands for part of the feature, as `e.endFaces()` does.

- **A connector source** in a part body: `connector('axis', g.frame('axis'))`.
  The connector's origin, X and Z are the frame's ([[api/connector]]).
- **A plane input**: `plane(g.frame('axis'), 5)` is the frame moved 5 along
  its Z ([[api/plane]]); a sketch stands on it like on any plane.
- **A repeat's copy** has its own frame where the copy stands:
  `r.instance(1).frame('axis')` ([[api/repeat]]).
- A name the class doesn't declare is refused where `frame()` is called (the
  model fails to compile): "`gear: 'hub' is not a frame of the feature — its
  frames are axis`".
- A declared frame the build never set fails the statement that reads it:
  "`gear: its build set no frame 'top' — set it with this.setFrames({ top:
  plane })`".

## Example: a bushing and its axis

A plain bushing standing on a planar face, or on the XY plane when no face
is picked. Its `axis` frame is where it stands: origin at the foot of the
bore, Z up the bore.

```feature.js
// bushing.feature.js
// A plain bushing: a sleeve with a bore, standing on a planar face (centred
// on it) or, with no face picked, on the XY plane at the origin. Its `axis`
// frame is where it stands: origin at the foot of the bore, Z up the bore.
import { Feature, defineFeature } from 'fluidcad/sdk';
import { BooleanOps, Primitives, ShapeOps } from 'fluidcad/sdk/kernel';
import { Matrix4, Plane } from 'fluidcad/math';

export class Bushing extends Feature.with({
  face: { picker: 'face', label: 'On face', surface: 'planar', optional: true },
  outer: { type: 'length', default: 16, min: 0, label: 'Outer diameter' },
  bore: { type: 'length', default: 10, min: 0, label: 'Bore' },
  length: { type: 'length', default: 20, min: 0 },
}, {
  frames: { axis: { label: 'Bushing axis' } },
}) {
  static id = 'bushing';

  buildTool() {
    const { face, outer, bore, length } = this.values;
    if (!(bore < outer)) {
      throw new Error(`bushing: the bore (${bore}) must be narrower than the sleeve (${outer})`);
    }
    let base = Plane.XY();
    if (face !== undefined) {
      const faces = this.facesOf(face);
      if (faces.length !== 1) {
        throw new Error(`bushing: pick one planar face to stand on (got ${faces.length} faces)`);
      }
      const plane = faces[0].getPlane();
      base = new Plane(plane.projectPoint(faces[0].center()), plane.xDirection, plane.normal);
    }

    // Built standing on XY, then moved onto its base.
    const sleeve = Primitives.makeCylinder(outer / 2, length);
    const hole = Primitives.makeCylinder(bore / 2, length);
    const tube = BooleanOps.cutShapes(sleeve, hole);
    sleeve.dispose();
    hole.dispose();
    const placed = ShapeOps.transform(tube, Matrix4.fromBasis(base.xDirection, base.yDirection, base.normal, base.origin));
    tube.dispose();

    this.setFrames({ axis: base });
    return [placed];
  }
}

export const bushing = defineFeature(Bushing, {
  label: 'Bushing',
  group: 'create',
  operations: ['add', 'new'],
  call: ['face', { outer: 'outer', bore: 'bore', length: 'length' }],
});
```

In a part file, the frame is a connector source. A flanged bearing seat: a
Ø60 flange with a bushing standing on its top face, and an `axis` connector
on the bushing's axis for a shaft to mate to:

```fluid.js
import { part, sketch, circle, extrude, connector } from "fluidcad/core";
import { fix, diameter } from "fluidcad/constraints";
import { bushing } from "./bushing.feature.js";

export const bearingSeat = part("Bearing seat", () => {
  sketch("xy", () => {
    const rim = circle([0, 0], 60);
    fix(rim.center(), [0, 0]);
    diameter(rim, 60);
  });
  const flange = extrude(8);

  const b = bushing(flange.endFaces(), { outer: 22, bore: 12, length: 25 });
  connector("axis", b.frame("axis"));   // origin on the flange's top face, Z up the bore
});
```

Made a generated part, the bushing gets the same connector with no part
body: `definePart` turns each declared frame into a connector of its name
([[api/define-part]]). The `face` pick is optional, so the part leaves it
out and the bushing stands on its own origin:

```fluid.js
import { definePart } from "fluidcad/sdk";
import { Bushing } from "./bushing.feature.js";

// parts/bushing.part.js — insert(bushingPart, { bore: 12 }).connectors.axis
export const bushingPart = definePart(Bushing, { label: 'Bushing', description: 'A plain bushing on its axis connector' });
```

## In a package

The gears package (`@fluidcad/gears`) works its frames out in a module of
plain vectors (`features/lib/frames.js`), unit tested without the engine,
and its features set them with `this.setFrames({ axis: frame.axis })`:

- `axis` (gear, internal gear): origin on the axis, on the plane the gear
  stands on; Z up the axis, the way the teeth run; X the phase reference. It
  is where the gear stands before its phase turns the teeth and its offset
  moves them, so a gear on a revolute mate keeps its axis while its phase
  meshes it.
- `pitch` (rack): on the pitch line at the middle of the rack; Z along the
  rack, the travel a slider takes; X toward the tips.

Set a frame where a mate needs it, independent of values that only move
the geometry along or about it: then changing those values moves the
geometry on the frame, never the frame.
