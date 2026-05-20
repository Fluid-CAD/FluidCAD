---
id: api/cut
title: cut(distance?, target?)
summary: Subtractive extrude. Same calling conventions as extrude, but always removes material. No-arg form goes through all — easy to do by accident.
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
`.draft()`, `.endOffset()`, `.thin()`, `.pick()`, `.scope()`, plus
`.startEdges()`, `.endEdges()`, `.internalEdges()`, `.internalFaces()`.

## Direction convention

`cut` is the mirror of `extrude` — it goes *into* the material, not
out of it:

- **Positive `distance`** cuts in the **opposite direction of the
  sketch normal** (into the solid the sketch sits on). This is the
  normal pocket case.
- **Negative `distance`** cuts **along the sketch normal** (out of the
  same side the sketch faces).
- **`cut()` with no args** is **through-all**, again opposite the sketch
  normal — easy to do by accident, so pass an explicit distance when
  you want a finite pocket.

## Example

```fluid.js
import { circle, cut, extrude, rect, sketch } from "fluidcad/core";

sketch("xy", () => rect(120, 80).centered());
const block = extrude(30);
sketch(block.endFaces(), () => circle(20));
cut(10);                               // 10mm-deep blind pocket
```

See [[api/extrude]] for the additive counterpart and
[[concepts/last-selection]] for the implicit-sketch consumption model.
