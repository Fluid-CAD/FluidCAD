---
id: api/select
title: select(...filters)
summary: Runs filters across the entire scene and stores the result as the implicit "last selection." The next op that needs a selection picks it up automatically.
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
stored on the scene; the next op that takes a selection consumes it.

For accessor-driven selections off a specific feature (e.g., the top
faces of one extrude), use the direct accessor instead —
`e.endFaces(...filters)` — to avoid scanning the rest of the scene.

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
