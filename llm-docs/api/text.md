---
id: api/text
title: text(string) / text(plane, string) / text(string, path)
summary: Renders a text string as sketch geometry — glyph outlines that extrude, wrap, or follow a path like any other profile.
tags: [api, 2d, sketch]
symbols: [text]
seeAlso: [api/sketch, api/wrap, api/extrude, api/types/text]
---

# text

Imported from `fluidcad/core`.

```ts
text(text: string)                           // inside a sketch, at the cursor
text(plane: PlaneLike | SceneObject, text: string)   // standalone, on a plane or face
text(text: string, path: SceneObject)        // glyphs laid out along a sketch path
```

Returns `Text` (an extrudable geometry). Glyph outlines become regular
sketch profiles: `extrude()` them for 3D text, `wrap()` them onto a
cylinder, or use them as cut profiles. The string starts at the sketch
cursor (or the plane origin) with the baseline along the local x axis.

Chain methods:

- `.size(height)` — cap height in mm (default 10).
- `.font(name)` / `.weight(400 | "bold")` / `.bold()` / `.italic()` —
  typeface selection; system fonts are resolved by family name.
- `.align("left" | "center" | "right" | "start" | "end" | "space-between" | "space-around")` —
  alignment relative to the cursor, or along a path; `"space-between"` and
  `"space-around"` distribute glyphs over the whole path like the CSS
  flexbox values (path text only).
- `.lineSpacing(factor)` / `.letterSpacing(extra)` — multi-line and
  tracking control.
- Path layout only: `.offset(distance)` — shift glyphs off the path,
  `.flip()` — mirror to the other side, `.startAt(distance)` — arc-length
  start position.

## Example

```fluid.js
import { extrude, sketch, text } from "fluidcad/core";

sketch("xz", () => {
    text("FluidCAD").size(14).bold();
});
extrude(4);
```

See [[api/wrap]] for wrapping text onto cylinders and cones, and
[[api/types/text]] for the full chain-method reference.
