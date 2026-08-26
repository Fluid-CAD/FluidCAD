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
import { color, extrude, line, sketch } from "fluidcad/core";

sketch("xy", () => {
  line([-40, -30], [40, -30]);
  line([40, -30], [40, 30]);
  line([40, 30], [-40, 30]);
  line([-40, 30], [-40, -30]);
});
const e = extrude(20);
color("#3498db", e.endFaces());
```

See [[api/select]] for the implicit-selection model that `color` plugs
into.
