---
id: api/wrap
title: wrap(thickness, sketch?, face)
summary: Develops a sketch onto a cylindrical or conical face and raises it by a thickness — embossed or engraved labels, logos, and features that follow a curved wall.
tags: [api, 3d, solid]
symbols: [wrap]
seeAlso: [api/sketch, api/types/text, api/select, api/extrude]
---

# wrap

Imported from `fluidcad/core`.

```ts
wrap(thickness, face: SceneObject)                        // wraps the last sketch
wrap(thickness, sketch: SceneObject, face: SceneObject)
```

Returns `Wrap` (extends `BooleanOperation`). Bends a flat sketch onto a
curved face like a label onto a bottle: the sketch is developed onto the
surface with lengths preserved (a true wrap, not a projection), then
thickened by `thickness` along the surface normal. `thickness` must be
positive; the operation mode picks the direction:

- default / `.add()` — emboss: the pad is raised off the surface and fused.
- `.remove()` — engrave: the sketch is sunk `thickness` deep into the surface.
- `.new()` — keep the wrapped pad as a standalone solid.
- `.scope(...)` — limit which solids are fused/cut.

The target `face` must be **cylindrical or conical** (e.g.
`select(face().cylinder())`). Placement: the sketch plane's origin lands on
the nearest point of the surface, the surface axis direction maps to the
matching in-plane sketch direction, and sketch coordinates are measured from
there along the unrolled surface. The plane's offset from the surface is
ignored; the plane must not be perpendicular to the target's axis, and the
sketch cannot span more than one full turn.

Sketch regions keep their holes (nested profiles are subtracted), and
`.pick(point)` / `.drill(false)` work as in `extrude`. Face/edge accessors:
`startFaces` (on the target surface), `endFaces` (raised/engraved faces),
`sideFaces` (outer-boundary walls), `internalFaces` (hole walls), plus the
matching `*Edges` variants.

## Example

```fluid.js
import { cylinder, move, plane, select, sketch, text, wrap } from "fluidcad/core";
import { face } from "fluidcad/filters";

cylinder(25, 60);
const target = select(face().cylinder());

sketch(plane("front", 25), () => {
    move([0, 24]);
    text("FLUID").size(12);
});

wrap(1, target);
```

Use `wrap(1, target).remove()` on the same scene to engrave the text
instead. See [[api/types/text]] for text options and [[api/select]] for
picking the target face.
