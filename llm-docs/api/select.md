---
id: api/select
title: select(...filters)
summary: Runs filters across the entire scene and stores the result as the implicit "last selection." The next op that needs a selection picks it up automatically. Builders pick one match with first()/last()/at(i) and grow it with withTangents() or withChain().
tags: [api, selection]
symbols: [select]
seeAlso: [api/face-filter, api/edge-filter, concepts/last-selection]
---

# select

Imported from `fluidcad/core`.

```ts
select(...filters: (FaceFilter | EdgeFilter)[])
```

Each filter contributes candidates; the final selection is the **union**
across all filter arguments (whereas chained calls within a single
filter — `.line()` then `.onPlane(...)` — are ANDed). The selection is
stored on the scene; the next op that takes a selection consumes it, except
`color()`, which paints the selection and leaves it intact for a later op.

For accessor-driven selections off a specific feature (e.g., the top
faces of one extrude), use the direct accessor instead —
`e.endFaces(...filters)` — to avoid scanning the rest of the scene.

## Picking one, and growing a chain

Each filter builder also carries how its matches are picked and grown:

- `.first()`, `.last()`, `.at(i)` — keep one match, in the kernel's
  iteration order (the last positional call on a builder wins)
- `.withTangents()` — grow the selection along tangent neighbours: edges
  that continue each other smoothly at a shared vertex (not a cusp, where
  one folds back onto the other), faces that meet without a crease
- `.withChain()` — grow along **connected** neighbours, tangent or not:
  edges that share a vertex, faces that share an edge

`withChain()` never leaves what the builder's predicates accept: the
predicates are the territory, and a seed rule plants where the chain
starts — a positional selector (`at(i)`, `first()`, `last()`), or with none,
a rank written as the builder's **last** stage (`nearest`, `farthest`,
`nth`, `largest`, `smallest`), the stages before it being the territory.
Every accepted shape connected to a seed through accepted shapes joins:

```js
s.boundaryEdges(edge().at(3).withChain())           // the rim loop that holds rim edge 3
select(edge().boundary().nearest("z").withChain())  // the rim loops that touch the bottom
select(face().cylinder().at(0).withChain())         // the connected run of cylindrical faces holding the first
```

Inside a bucket accessor the bucket is the candidate set, so
`e.endEdges(edge().first().withChain())` is the loop of end edges that
holds the first. A `withChain()` with no seed rule throws where it is
written — every match would be a seed and the chain would add nothing — and
so does one whose rank is not the last stage. Each builder grows its own
chain before the builders of a `select()` are joined; `withTangents()` then
grows the joined set over every candidate.

```fluid.js
import { cut, extrude, fillet, line, select, sketch, xAxis, yAxis } from "fluidcad/core";
import { coincident, distance, horizontal, symmetric, vertical } from "fluidcad/constraints";
import { edge } from "fluidcad/filters";

const rect = (w, h) => {
  const b = line([-w / 2, -h / 2], [w / 2, -h / 2]);
  const r = line([w / 2, -h / 2], [w / 2, h / 2]);
  const t = line([w / 2, h / 2], [-w / 2, h / 2]);
  const l = line([-w / 2, h / 2], [-w / 2, -h / 2]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(t);
  vertical(l);
  symmetric(b.start(), b.end(), yAxis());
  symmetric(r.start(), r.end(), xAxis());
  distance(b.start(), b.end(), w);
  distance(r.start(), r.end(), h);
};
sketch("xy", () => rect(60, 40));
const block = extrude(20);
sketch(block.endFaces(), () => rect(20, 10));
cut(8);
// The top face holds two loops: its outline and the pocket's mouth. The
// edge nearest -x seeds the chain, which stays on the top face's edges and
// so takes the outline only.
select(edge().onPlane("xy", 20).nearest("x").withChain());
fillet(2);
```

## Inside a sketch

Inside a `sketch(...)` body, `select(edge()...)` evaluates against the
**active sketch's edges** (statements before the select) instead of the
3D scene. Sketch selections are edge-only — `select(face()...)` throws.
The result participates in the same last-selection contract: the next 2D
op (`fillet`, `offset`) consumes it, and it can also be passed as an
explicit target. For single-op selections the filter-argument form
(`fillet(4, edge().line())`) usually reads better.

```fluid.js
import { extrude, fillet, line, select, sketch } from "fluidcad/core";
import { edge } from "fluidcad/filters";
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

sketch("xy", () => {
  const b = line([0, 0], [80, 0]);
  const r = line([80, 0], [80, 60]);
  const t = line([80, 60], [0, 60]);
  const l = line([0, 60], [0, 0]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(b);
  vertical(r);
  horizontal(t);
  vertical(l);
  fix(b.start(), [0, 0]);
  distance(b.start(), b.end(), 80);
  distance(r.start(), r.end(), 60);
  select(edge().line());   // the four sides
  fillet(4);               // consumes the sketch selection
});
extrude(10);
```

## Example

```fluid.js
import { extrude, fillet, line, origin, select, sketch, xAxis, yAxis } from "fluidcad/core";
import { edge } from "fluidcad/filters";
import { coincident, distance, horizontal, symmetric, vertical } from "fluidcad/constraints";

sketch("xy", () => {
  const b = line([-40, -30], [40, -30]);
  const r = line([40, -30], [40, 30]);
  const t = line([40, 30], [-40, 30]);
  const l = line([-40, 30], [-40, -30]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(t);
  vertical(l);
  symmetric(b.start(), b.end(), yAxis());   // bottom side centred on Y (and horizontal)
  symmetric(r.start(), r.end(), xAxis());   // right side centred on X (and vertical)
  distance(b.start(), b.end(), 80);
  distance(r.start(), r.end(), 60);
});
const e = extrude(20);
select(edge().verticalTo("xy"));
fillet(2);                              // consumes the selection above
```

See [[api/face-filter]] and [[api/edge-filter]] for the per-filter
predicates, and [[concepts/last-selection]] for the implicit-consumption
contract.
