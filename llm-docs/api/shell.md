---
id: api/shell
title: shell(thickness, ...openFaces?)
summary: Hollows a solid into a thin wall. Pass faces to remove (open the shell). Negative thickness shells inward; positive shells outward.
tags: [api, 3d, modifier]
symbols: [shell]
seeAlso: [api/extrude, api/fillet]
---

# shell

Imported from `fluidcad/core`.

```ts
shell(thickness?)                      // default thickness 2.5, walls inward (negative)
shell(thickness, ...selections)        // remove these faces (open the shell)
```

Returns `Shell` with:

- `.internalFaces()`, `.internalEdges()` — the new inner wall geometry.
- `.join(type)` — corner join style: `"arc"` (default), `"intersection"`
  (sharp), or `"tangent"`.

**Sign of thickness matters.** Negative thickness shells inward
(preserving the outer shape and hollowing out the interior). Positive
shells outward (preserving the inner shape and adding wall material).

**When the shell fails.** If the walls cannot be offset, the feature reports
`shell: could not hollow the solid — wall offset failed.` and the solid
stays in the scene un-hollowed. The wall may be thicker than a nearby
feature or radius of curvature, or a cut or groove may open onto a removed
face: use a thinner wall, fewer or simpler open faces, or shell before
cutting small features. Walls that meet at a corner at one end and blend
smoothly at the other (a square-to-round loft) may hollow only when opened
at the cornered end: for `l = loft(square, round)`,
`shell(-2, l.startFaces())` hollows it and `shell(-2, l.endFaces())`
fails. A loft between round profiles (circles, ellipses) has no such corner
and hollows from either end.

## Example

```fluid.js
import { extrude, fillet, line, origin, shell, sketch, xAxis, yAxis } from "fluidcad/core";
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
const e = extrude(40);
const s = shell(-2, e.endFaces());     // open-top container, 2mm walls
fillet(0.5, s.internalEdges());
```

See [[api/extrude]] for the base solid and [[api/fillet]] for refining
the new inner edges.
