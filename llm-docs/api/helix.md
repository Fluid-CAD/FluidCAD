---
id: api/helix
title: helix(axis | source)
summary: Creates a helical wire around an axis or derived from existing geometry (cylindrical/conical face, line or circular edge) — the path for springs, threads, and coils. Sweep a profile along it to make material.
tags: [api, 3d, wire]
symbols: [helix]
seeAlso: [api/sweep, api/axis, api/select, api/types/helix]
---

# helix

Imported from `fluidcad/core`.

```ts
helix(axis: AxisLike)          // e.g. "z", an axis() object, or axis-like
helix(source: SceneObject)     // face or edge selection
```

Returns `Helix` (extends `SceneObject`) — a helical **wire**, not a solid.
Pass it as the path to `sweep(path, profile)` to build springs and threads.

Chain to configure geometry; any two of pitch/turns/height determine the
third:

- `.pitch(p)` — axial rise per full revolution.
- `.turns(n)` — number of revolutions (fractional allowed; default 1).
- `.height(h)` — total axial extent (default 50, or `pitch × turns`).
- `.radius(r)` — start radius (default 20 for axis/line input; for a
  cylindrical face defaults to the face radius).
- `.endRadius(r)` — end radius; when ≠ `radius()` the helix tapers
  conically. Ignored for face/circular-edge sources.
- `.startOffset(mm)` / `.endOffset(mm)` — shift the start/end along the
  axis (negative start offset or positive end offset extends past the
  source's bounds — useful for threads that run off the stock).

With a `SceneObject` source the frame is derived from the geometry:
a **cylindrical face** supplies axis, radius, and height; a **conical
face** makes the helix follow the cone's taper (radii derived, overrides
ignored); a **line edge** becomes the axis with height = line length; a
**circular edge** supplies axis (circle normal) and radius. Multi-shape
sources must be narrowed with `select(...)` to one face or edge.

Constraints: turns > 0, pitch ≠ 0, radii > 0 over the whole height.

## Example

```fluid.js
import { sketch, circle, hMove, helix, sweep } from "fluidcad/core";

const path = helix("z").radius(15).pitch(10).turns(5);

const profile = sketch("left", () => {
    hMove(15);
    circle(2);
});

sweep(path, profile);
```

For a thread, build the helix at a cylinder's surface radius (or directly
from the face via `helix(select(face().cylinder()))`) and sweep a profile —
the sweep fuses with the cylinder by default; chain `.remove()` on the
sweep to carve a groove instead. See [[api/sweep]] for sweep options and
[[api/types/helix]] for the full method list.
