---
id: api/cut
title: cut(distance?, target?)
summary: Subtractive extrude. Same calling conventions as extrude, but always removes material. Positive distance cuts opposite the sketch normal (into the solid); negative cuts along it. No-arg form goes through all.
tags: [api, 3d, solid]
symbols: [cut]
seeAlso: [api/extrude, api/sketch, concepts/last-selection]
---

# cut

Imported from `fluidcad/core`.

```ts
cut()                                  // through-all using the last sketch
cut(target: SceneObject)
cut(distance, target?)
cut(distance1, distance2, target?)
cut(face: SceneObject)                 // cut up to a face
cut("first-face")
cut("last-face")
cut(face, target)
```

Returns `Cut`. Always subtractive — equivalent to `extrude(...).remove()`.
Same chain set as `extrude` except no `.add()` / `.new()`: `.symmetric()`,
`.draft()`, `.endOffset()`, `.thin()`, `.region()`, `.scope()`, plus
`.startEdges()`, `.endEdges()`, `.internalEdges()`, `.internalFaces()`.
`.region(name)` selects a region the sketch declares with `region()` —
see [[api/region]] and [[api/extrude]].

## Direction convention

`cut` is the mirror of `extrude` — it goes *into* the material, not
out of it:

- **Positive `distance`** cuts in the **opposite direction of the
  sketch normal** (into the solid the sketch sits on). This is the
  normal pocket case.
- **Negative `distance`** cuts **along the sketch normal** (out of the
  same side the sketch faces).
- **`cut()` with no args** is **through-all**, again opposite the sketch
  normal.

## Example

```fluid.js
import { cut, extrude, line, offset, origin, project, sketch, xAxis, yAxis } from "fluidcad/core";
import { coincident, distance, horizontal, symmetric, vertical } from "fluidcad/constraints";

sketch("xy", () => {
  const b = line([-60, -40], [60, -40]);
  const r = line([60, -40], [60, 40]);
  const t = line([60, 40], [-60, 40]);
  const l = line([-60, 40], [-60, -40]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(t);
  vertical(l);
  symmetric(b.start(), b.end(), yAxis());   // bottom side centred on Y (and horizontal)
  symmetric(r.start(), r.end(), xAxis());   // right side centred on X (and vertical)
  distance(b.start(), b.end(), 120);
  distance(r.start(), r.end(), 80);
});
const block = extrude(30);
sketch(block.endFaces(), () => {
  // The face plane's origin isn't guaranteed to be the face centroid —
  // anchor to a projected reference instead of raw coordinates.
  const outline = project(block.endFaces()).guide();
  offset(-15, outline);                // pocket profile, inset 15
});
cut(10);                               // 10mm-deep blind pocket
```

See [[api/extrude]] for the additive counterpart and
[[concepts/last-selection]] for the implicit-sketch consumption model.
