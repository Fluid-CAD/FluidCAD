---
id: api/hole
title: hole(size, ...placements)
summary: Cuts drilled, clearance or tapped fastener holes at connectors, sketch points or face/edge anchors, with optional counterbore or countersink, blind or through-all termination, and .fasten() to tap the mating solid of a clearance hole.
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
- `.fasten(target, pitch?, depth?, tipAngle?)` — clearance holes
  of a string size only (not a numeric size, not `.tapped()`). `target` is the
  other solid the fastener threads into: it gets the matching tapped hole on
  the same axis, at the tap-drill diameter for the size, and is left out of the
  clearance cut whatever `.scope()` says. `pitch` in mm / threads per inch,
  omitted or `null` = coarse (write `null` when a depth follows). `depth` =
  blind depth to the shoulder, measured from the face where the axis enters
  `target` (not from the placement); omitted = through the whole solid.
  `tipAngle` = drill point below a blind depth (118), only with a depth. Errors
  if the axis never reaches `target`.
- `.scope(...solids)` — which solids are cut (default: all).

Accessors: `faces()` (walls), `edges()` (every rim), `startEdges()` (entry
rims), `endEdges()` (floor or exit rims); with `.fasten()` each lists the
clearance cut's geometry first, then the tapped holes'. Repeatable with `repeat()`.

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

## Example: fasten a cover to a base

One clearance hole in the cover; the base gets the M6 tapped hole (Ø5), 12
deep from its top face with a 118° drill point.

```fluid.js
import { sketch, line, point, extrude, hole } from "fluidcad/core";
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

sketch("xy", () => {
  const b = line([-20, -15], [20, -15]);
  const r = line([20, -15], [20, 15]);
  const t = line([20, 15], [-20, 15]);
  const l = line([-20, 15], [-20, -15]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(b);
  vertical(r);
  horizontal(t);
  vertical(l);
  fix(b.start(), [-20, -15]);
  distance(b.start(), b.end(), 40);
  distance(r.start(), r.end(), 30);
});
const base = extrude(20);
sketch(base.endFaces(), () => {
  const b = line([-20, -15], [20, -15]);
  const r = line([20, -15], [20, 15]);
  const t = line([20, 15], [-20, 15]);
  const l = line([-20, 15], [-20, -15]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(b);
  vertical(r);
  horizontal(t);
  vertical(l);
  fix(b.start(), [-20, -15]);
  distance(b.start(), b.end(), 40);
  distance(r.start(), r.end(), 30);
});
const cover = extrude(8).new();
const seat = sketch(cover.endFaces(), () => {
  const p = point([0, 0]);
  fix(p, [0, 0]);
  return { p };
});
hole('M6', seat.geometries.p).fasten(base, null, 12, 118);
```

See [[api/connector]] for holes at a part's mating frames and [[api/repeat]] for bolt circles.
