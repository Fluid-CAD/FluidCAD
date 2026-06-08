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
import { draft, extrude, rect, sketch } from "fluidcad/core";

sketch("xy", () => rect(80, 50).centered());
const e = extrude(30);
draft(5, e.sideFaces());
```

See [[api/extrude]] for inline draft and [[api/shell]] for hollowing.
