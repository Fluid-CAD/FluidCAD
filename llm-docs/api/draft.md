---
id: api/draft
title: draft(angle, ...faces?)
summary: Applies a draft angle to selected faces — pulls them outward (positive) or inward (negative) along a reference direction.
tags: [api, 3d, modifier]
symbols: [draft]
seeAlso: [api/extrude, api/shell]
---

# draft

Imported from `fluidcad/core`.

```ts
draft(angle)                                        // uses last selection
draft(angle, ...selections)
```

Returns `Draft`. Tilts the selected faces by `angle` degrees. Use it for
mold-release surfaces or any side wall that needs a taper distinct from
its base extrusion.

For draft applied during the pull itself, reach for
`extrude(d).draft(angle)` — the inline form is usually less plumbing.

## Example

```fluid.js
import { draft, extrude, line, origin, sketch, xAxis, yAxis } from "fluidcad/core";
import { coincident, distance, horizontal, symmetric, vertical } from "fluidcad/constraints";

sketch("xy", () => {
  const b = line([-40, -25], [40, -25]);
  const r = line([40, -25], [40, 25]);
  const t = line([40, 25], [-40, 25]);
  const l = line([-40, 25], [-40, -25]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(t);
  vertical(l);
  symmetric(b.start(), b.end(), yAxis());   // bottom side centred on Y (and horizontal)
  symmetric(r.start(), r.end(), xAxis());   // right side centred on X (and vertical)
  distance(b.start(), b.end(), 80);
  distance(r.start(), r.end(), 50);
});
const e = extrude(30);
draft(5, e.sideFaces());
```

See [[api/extrude]] for inline draft and [[api/shell]] for hollowing.
