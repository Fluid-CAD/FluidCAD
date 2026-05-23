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

## Example

```fluid.js
import { extrude, fillet, rect, select, sketch } from "fluidcad/core";
import { edge } from "fluidcad/filters";

sketch("xy", () => rect(80, 60).centered());
const e = extrude(20);
select(edge().verticalTo("xy"));
fillet(2);                              // consumes the selection above
```

See [[api/face-filter]] and [[api/edge-filter]] for the per-filter
predicates, and [[concepts/last-selection]] for the implicit-consumption
contract.
