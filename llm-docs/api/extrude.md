---
id: api/extrude
title: extrude(distance, target?)
summary: Pulls the last sketch (or an explicit one) along the sketch plane normal. Auto-fuses with any solid it touches.
tags: [api, solid, primitive, 3d]
symbols: [extrude]
seeAlso: [api/sketch, api/fillet, concepts/last-selection]
---

# extrude

Imported from `fluidcad/core`.

```ts
extrude(target?: SceneObject)                 // default distance (25)
extrude(distance: number, target?)
extrude(distance1, distance2, target?)        // two distances → asymmetric extrude
extrude(face, target?)                        // extrude up to a face
extrude("first-face", ...filters, target?)    // up to nearest intersecting face
extrude("last-face", ...filters, target?)     // up to farthest intersecting face
```

Returns `Extrude` (extends `BooleanOperation`). Pulls the last sketch along
its plane normal. With no `target`, auto-fuses with anything it touches.

## Chain methods

- `.symmetric()` — extrude equally in both directions; `extrude(30).symmetric()` gives total span 60.
- `.draft(angle | [start, end])` — taper. Positive expands outward, negative tapers inward.
- `.endOffset(d)` — shift the end face by `d` along the extrusion direction.
- `.thin(offset)` / `.thin(o1, o2)` — thin-walled solid from the profile edges.
- `.drill(bool)` — `true` (default) treats inner closed regions as holes.
- `.pick(...points)` — restrict to specific regions of a multi-region sketch.
- `.add()` / `.new()` / `.remove()` / `.scope(...)` — boolean scope controls.

## Direct accessors

```js
const e = extrude(30);
e.startFaces(); e.endFaces(); e.sideFaces();
e.startEdges(); e.endEdges(); e.sideEdges();
e.internalFaces(); e.internalEdges();
e.capFaces(); e.capEdges();   // for thin extrudes from open profiles
```

Each accessor takes numeric indices and/or `FaceFilterBuilder` /
`EdgeFilterBuilder` to scope the selection:

```js
e.sideFaces(0);                     // first side face
e.sideFaces(face().cylinder());     // only cylindrical side faces
e.endEdges(0, 2);                   // by index
```

## Examples

```fluid.js
import { circle, extrude, line, origin, select, sketch, xAxis, yAxis } from "fluidcad/core";
import { face } from "fluidcad/filters";
import { coincident, diameter, distance, horizontal, symmetric, vertical } from "fluidcad/constraints";

sketch("xy", () => {
  const b = line([-50, -30], [50, -30]);
  const r = line([50, -30], [50, 30]);
  const t = line([50, 30], [-50, 30]);
  const l = line([-50, 30], [-50, -30]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(t);
  vertical(l);
  symmetric(b.start(), b.end(), yAxis());   // bottom side centred on Y (and horizontal)
  symmetric(r.start(), r.end(), xAxis());   // right side centred on X (and vertical)
  distance(b.start(), b.end(), 100);
  distance(r.start(), r.end(), 60);
});
extrude(30);  // simple box

sketch("xy", () => {
  const c = circle([0, 0], 50);
  coincident(c.center(), origin());
  diameter(c, 50);
});
extrude(30).symmetric().draft(5);   // bidirectional tapered cylinder

sketch("xy", () => {
  const tube = circle([80, 0], 30);
  horizontal(origin(), tube.center());
  distance(origin(), tube.center(), 80);
  diameter(tube, 30);
});
extrude(30).thin(-2);               // thin-walled tube (2mm inward)

sketch("xy", () => {
  const boss = circle([0, 0], 20);
  coincident(boss.center(), origin());
  diameter(boss, 20);
});
const target = select(face().onPlane("xy", 30));
extrude(target);                    // extrude up to the box's top face
```

See [[api/fillet]] for follow-up edge filleting, [[api/sketch]] for sketch
inputs, and [[concepts/last-selection]] for the implicit consumption model.
