---
id: api/split-trim
title: split / trim
summary: Sketch-level cleanup. `split` breaks intersecting geometries at their crossings; `trim` discards the unwanted segments.
tags: [api, 2d, modifier]
symbols: [split, trim]
seeAlso: [api/sketch, api/edge-filter]
---

# split / trim

Imported from `fluidcad/core`.

```ts
split()                                  // split all intersecting geometries
split(...objects)

trim()                                   // trim all segments at crossings
trim(...targets)                         // remove the matching whole edges
```

Both run inside a sketch context. `split` keeps every piece around so
you can reference them individually; `trim` keeps only the segments you
want, discarding the others. `trim(...)` with arguments removes whole
edges; targets are the shared 2D op forms — geometries, edge accessors
(`r.edge('top')`), or [[api/edge-filter]] filters (`edge().line()`).

## Example

```fluid.js
import { circle, extrude, hLine, sketch, trim } from "fluidcad/core";
import { edge } from "fluidcad/filters";

sketch("xy", () => {
  circle(50);
  hLine([50, 0], 100);        // cuts the circle in half
  trim(edge().line());        // drop the line, keep the circle halves
});
extrude(2);
```

Whole-edge removal by accessor:

```fluid.js
import { rect, sketch, trim } from "fluidcad/core";

sketch("xy", () => {
  const r = rect(80, 60);
  trim(r.edge('top'));    // remove one whole edge
});
```

See [[api/edge-filter]] for the filter language `trim` accepts.
