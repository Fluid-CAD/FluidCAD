---
id: api/color
title: color(value, selection?)
summary: Paints a face, edge, or solid. Accepts CSS color strings (named, hex, rgb). Without a target, paints the last selection, or every face in the current context when there is no selection.
tags: [api, utility, appearance]
symbols: [color]
seeAlso: [api/select, api/face-filter]
---

# color

Imported from `fluidcad/core`.

```ts
color(value: string)                                // CSS color, applies to last selection
color(value: string, selection: SceneObject)
```

Accepts named CSS colors (`"red"`), hex (`"#3498db"`), or `rgb(...)`.
With no explicit target, paints the last selection — pair with
`select(...)` or a direct accessor like `e.endFaces()`. When there is no
selection at all, it paints every face in the current context, exactly as if
you had written `select(face())` first.

## Example

```fluid.js
import { color, extrude, line, origin, sketch, xAxis, yAxis } from "fluidcad/core";
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
color("#3498db", e.endFaces());
```

See [[api/select]] for the implicit-selection model that `color` plugs
into.
