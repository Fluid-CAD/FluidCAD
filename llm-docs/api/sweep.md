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

For an authored constant-radius `helix`, automatic transport rotates the
profile about the stored helix axis. A profile on `plane(path, position)`
keeps that station, including interior positions and tangent extensions.
Its initial alignment is normal to the actual path tangent; either sketch
normal sign is accepted without changing an already aligned profile. The
profile's size and offset are preserved through the subsequent screw motion.
Copied, selected and mirrored helix edges retain this behavior.

The helical surface is built in spans of at most one revolution. This avoids
a kernel intersection failure on long helical faces that can leave only
edges on a cylinder instead of cutting the groove. Smooth span seams can
add faces/edges; the profile and transport remain the same.

Helix curve and swept-surface approximation errors must be finite,
nonnegative, and within a physical **0.0001 mm** fit budget, converted to
the document unit at build time. Sweep boundary tolerance is also
0.0001 mm; angular tolerance is 0.01 radians. A rejected fit reports its
stage, kernel status, transport/placement, requested tolerances, and input
dimensions. The builder does not retry with another orientation or larger
tolerances.

Each swept cutter also passes finite-bounds/volume, topology, closed-shell,
positive signed-volume, solid-count, and native OCCT self-interference
checks. Hole cuts and feature cut/fuse results are validated before adoption;
changed cleanup geometry is checked again. A cleanup that needs a repair
without trustworthy face/edge history is rejected. Errors name the failing
stage. A cut that misses the stock leaves it unchanged; successful complete
removal deletes the stock and returns no replacement solid.

Native self-interference checking requires the rebuilt `ocjs-fluidcad`
bindings (`BRepAlgoAPI_Check`). If absent, the build reports the missing
binding and fails instead of substituting another check. These checks can
add seconds to cylindrical sweeps and over a minute to complex tapered
sweeps. They are distinct from the basic inspection
`validate` report, which does not request native self-interference analysis.

Without a path-plane association, the profile's area centroid is localized
to the nearest path station. Equally close distinct stations are rejected;
use `plane(path, position)` to resolve the ambiguity. Unknown non-planar
paths use corrected Frenet transport. Tapered helices still use approximate
axis-binormal transport and have not been qualified for exact radial/axial
profile preservation.

This changes earlier cylindrical sweeps that accumulated unwanted profile
roll, especially near the old pitch threshold or at high turn counts.
Existing saved sources rebuild with the repaired automatic policy.

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
});

sketch("yz", () => {
  const c = circle([0, 0], 8);
  coincident(c.center(), origin());
  diameter(c, 8);
});
sweep(path);
```

See [[api/loft]] for blending between distinct profiles and
[[api/revolve]] for axis-driven sweeps.
