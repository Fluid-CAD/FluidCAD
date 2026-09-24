---
id: api/sweep
title: sweep(path)
summary: Sweeps the active sketch (profile) along a path sketch. The profile is consumed implicitly; the path is passed explicitly.
tags: [api, 3d, solid]
symbols: [sweep]
seeAlso: [api/sketch, api/extrude, api/loft, api/revolve]
---

# sweep

Imported from `fluidcad/core`.

```ts
sweep(path: SceneObject)                              // sweep last sketch along path
sweep(path: SceneObject, target?: SceneObject)
```

Returns `Sweep` (extends `BooleanOperation`). Chain: `.draft()`,
`.endOffset()`, `.drill()`, `.region()`, `.thin()`, plus boolean scope
methods. Direct accessors mirror `extrude`: `startFaces`, `endFaces`,
`sideFaces`, etc. `.region(name)` selects a region the profile sketch
declares with `region()` — see [[api/region]] and [[api/extrude]].

The path is typically a reusable sketch (open or closed wire) or an
edge selection. The profile is whatever sketch was last opened — usually
on a plane perpendicular to the path's start tangent.

## Example

```fluid.js
import { arc, circle, line, origin, sketch, sweep } from "fluidcad/core";
import { coincident, diameter, distance, fix, horizontal, radius, tangent } from "fluidcad/constraints";

const path = sketch("xy", () => {
  const run = line([0, 0], [100, 0]);
  const bend = arc([100, 0], [200, 100], [100, 100]);  // tangent continuation of the line
  fix(run.start(), [0, 0]);
  horizontal(run);
  distance(run.start(), run.end(), 100);
  coincident(run.end(), bend.start());
  tangent(run, bend);
  radius(bend, 100);
  horizontal(bend.center(), bend.end());   // a quarter turn
}).reusable();

sketch("yz", () => {
  const c = circle([0, 0], 8);
  coincident(c.center(), origin());
  diameter(c, 8);
});
sweep(path);
```

See [[api/loft]] for blending between distinct profiles and
[[api/revolve]] for axis-driven sweeps.
