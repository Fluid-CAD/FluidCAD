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
trim(...filters: EdgeFilter[])           // trim segments matching the filters
```

Both run inside a sketch context. `split` keeps every piece around so
you can reference them individually; `trim` keeps only the segments you
want, discarding the others. Pair `trim(...)` with an
[[api/edge-filter]] to target specific segments by length, orientation,
or parent.

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

See [[api/edge-filter]] for the filter language `trim` uses.
