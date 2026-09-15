---
id: api/chamfer
title: chamfer(distance, ...edges?)
summary: Flat angled break on a 3D edge. Symmetric, asymmetric (d1 × d2), or distance + angle forms.
tags: [api, 3d, modifier, edges]
symbols: [chamfer]
seeAlso: [api/fillet, api/extrude]
---

# chamfer

Imported from `fluidcad/core`.

```ts
chamfer(distance?)                                  // default 1, uses last selection
chamfer(distance, ...sceneObjects)
chamfer(d1, d2, isAngle?)                           // asymmetric or distance + angle
chamfer(d1, d2, isAngle, ...sceneObjects)
```

Returns a `SceneObject`. Operates on the last selection when no edges
are passed, just like [[api/fillet]].

## When to reach for chamfer vs fillet

Chamfers are cheaper computationally and faster to spec from a drawing —
prefer them for manufacturing edge breaks. Save fillets for visually
styled rounds or stress-relief features.

## Example

```fluid.js
import { chamfer, extrude, line, origin, sketch, xAxis, yAxis } from "fluidcad/core";
import { coincident, distance, horizontal, symmetric, vertical } from "fluidcad/constraints";

sketch("xy", () => {
  const b = line([-30, -20], [30, -20]);
  const r = line([30, -20], [30, 20]);
  const t = line([30, 20], [-30, 20]);
  const l = line([-30, 20], [-30, -20]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(t);
  vertical(l);
  symmetric(b.start(), b.end(), yAxis());   // bottom side centred on Y (and horizontal)
  symmetric(r.start(), r.end(), xAxis());   // right side centred on X (and vertical)
  distance(b.start(), b.end(), 60);
  distance(r.start(), r.end(), 40);
});
const e = extrude(20);
chamfer(2, e.endEdges());
```

See [[api/fillet]] for the rounded counterpart.
