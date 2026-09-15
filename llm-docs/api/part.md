---
id: api/part
title: "part(name, callback)"
summary: "Declares a named part — a lazy definition whose body builds the geometry, with param() as its parameter interface, connector() as its mating interface and expose() as its published geometry. Only an exported part() can be inserted into an assembly. Inside it shapes fuse with each other and never with siblings outside."
tags: [api, part, assembly]
symbols: [part]
seeAlso: [api/param, api/connector, api/expose, api/insert, concepts/assemblies, concepts/scene-graph]
---

# part

Imported from `fluidcad/core`.

```ts
part(name: string, callback: () => void): PartDefinition
```

Declares a **part**: a named container for modelling statements. Returns a
lazy definition — the callback runs when the file renders on its own (so an
open part file is what-you-see-is-what-you-get) and once per **variant**
when an assembly inserts it (`insert(def)` and `insert(def, { Length: 380 })`
are two builds; equal overrides share one).

Rules of thumb:

- A standalone model does not need `part()`; a `.part.js` file with bare
  statements renders.
- A model an assembly will insert **must** be a `part()` and the file must
  `export` it. Convention: one part per `.part.js` file, `bracket.part.js`
  exports `bracket`.
- Inside a part, shapes auto-fuse with each other and never with anything
  outside it — several components in one file each get their own part.
- Read parameters with `param()` inside the callback; declare `connector()`
  and `expose()` directly in the body (not inside a nested callback).
- The callback's return value is ignored; publish geometry with `expose()`
  and read it back as `def.features.<name>`.
- The part's numbers are in its file's unit; an assembly rescales it into
  the project unit on insert.

## Example

In the real file the definition is exported (`export const extrusion = part(...)`) so an assembly can insert it.

```fluid.js
import { part, param, sketch, circle, extrude, connector, origin } from "fluidcad/core";
import { coincident, diameter } from "fluidcad/constraints";

const extrusion = part("Extrusion", () => {
  const length = param("Length", 150, "number", { min: 20 });
  sketch("xy", () => {
    const c = circle([0, 0], 20);
    coincident(c.center(), origin());
    diameter(c, 20);
  });
  const e = extrude(length);
  connector("start", e.startFaces());
  connector("end", e.endFaces());
});
```

Two separate solids in one file:

```fluid.js
import { cylinder, extrude, line, origin, part, sketch, xAxis, yAxis } from "fluidcad/core";
import { coincident, distance, horizontal, symmetric, vertical } from "fluidcad/constraints";

part("base", () => {
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
  extrude(20);
});

part("pillar", () => {
  cylinder(15, 50).translate(0, 0, 20);
});
```

See [[concepts/assemblies]] for how parts are inserted and mated.
