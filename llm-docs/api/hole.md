---
id: api/hole
title: hole(size, ...placements)
summary: Cuts drilled, clearance or tapped fastener holes at connectors, sketch points or face/edge anchors, with optional counterbore or countersink and blind or through-all termination.
tags: [api, 3d, solid]
symbols: [hole]
seeAlso: [api/connector, api/point, api/repeat, api/cut]
---

# hole

Imported from `fluidcad/core`.

```ts
hole(diameter: number, ...placements)   // drilled hole of that diameter
hole(size: string, ...placements)       // fastener size: 'M6', 'M2.5', '1/4', '#10'
```

Returns `Hole`. Placements (at least one): a connector, a sketch point
exported from a sketch (`s.geometries.c.center()`, `s.geometries.p` for a
`point()` entity), or an anchored vertex on a solid (`e.endFaces().center()`,
`e.sideEdges(0).center()`). The hole drills opposite the placement's normal
(into the sketched face, out of a connector's Z). Chain methods, in this order:

- `.clearance(fit?)` — clearance diameter from ISO 273 / ASME B18.2.8 for a
  string size; fit `'close' | 'normal' | 'loose'`, normal by default (also the
  default when no chain is given).
- `.tapped(pitch?)` — tap-drill diameter for the size; coarse pitch by default,
  or a pitch in mm (metric) / threads per inch (inch). Threads are not modelled.
- `.counterbore(diameter?, depth?)` / `.countersink(diameter?, angle?)` — the
  entry; without values the socket-head / flat-head table for the size is used
  (a numeric size needs explicit values).
- `.depth(distance, tipAngle?)` — blind hole: depth to the shoulder, plus a
  drill point of that included angle (118 is a standard drill); omitted = through all.
- `.flip()` — drill along the normal instead.
- `.scope(...solids)` — which solids are cut (default: all).

Accessors: `faces()` (walls), `edges()` (every rim), `startEdges()` (entry
rims), `endEdges()` (floor or exit rims). Repeatable with `repeat()`.

## Example

```fluid.js
import { sketch, line, point, extrude, hole } from "fluidcad/core";
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

sketch("xy", () => {
  const b = line([-40, -25], [40, -25]);
  const r = line([40, -25], [40, 25]);
  const t = line([40, 25], [-40, 25]);
  const l = line([-40, 25], [-40, -25]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(b);
  vertical(r);
  horizontal(t);
  vertical(l);
  fix(b.start(), [-40, -25]);
  distance(b.start(), b.end(), 80);
  distance(r.start(), r.end(), 50);
});
const plate = extrude(10);
const holes = sketch(plate.endFaces(), () => {
  const p1 = point([-30, -15]);
  const p2 = point([30, 15]);
  fix(p1, [-30, -15]);
  fix(p2, [30, 15]);
  return { p1, p2 };
});
hole('M6', holes.geometries.p1, holes.geometries.p2).clearance('close').counterbore();
hole(5, plate.endFaces().center()).depth(6, 118);
```

See [[api/connector]] for holes at a part's mating frames and [[api/repeat]] for bolt circles.
