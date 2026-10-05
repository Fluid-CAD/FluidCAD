---
id: api/section
title: section(name, plane, options?)
summary: Saves a named section view — a cut plane the viewer clips the model at when the view is picked from the section menu, capping each body with hatching and painting overlaps red. Builds nothing and takes no timeline row.
tags: [api, utility, inspection]
symbols: [section]
seeAlso: [api/types/section, api/plane, api/select]
---

# section

Imported from `fluidcad/core`.

```ts
section(name: string, plane: PlaneLike | SceneObject, options?: { offset?: number, flip?: boolean })
```

Records a cut plane under a name. Nothing is built, nothing is consumed,
and the statement has no timeline row; the viewport's section menu lists
every `section()` in the file by name, and activating one cuts the model
open at that plane.

- **`plane`**: an origin plane (`'xy'`, `'xz'`, `'yz'`), a `plane()`
  statement, or a planar face selection, read the way `plane(face)` reads it.
- **`offset`**: moves the cut along the plane normal.
- **`flip`**: the normal points at the half that is removed; `flip: true`
  keeps that half instead.

While a view is active, every body the plane passes through is capped in
its own colour with hatching, and the volume two bodies share is painted
red — the same overlap the `interfere` MCP tool reports. Dragging the
view's arrow in the viewport rewrites `offset` in the statement.

```js
section('A-A', 'xz');                              // cut at the XZ plane
section('Mid', 'xy', { offset: 10 });              // 10 above XY
section('Top', plane(e.endFaces()), { flip: true }); // at the top face, keeping the top
```

## Example

```fluid.js
import { extrude, line, plane, section, sketch, xAxis, yAxis } from "fluidcad/core";
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
  symmetric(b.start(), b.end(), yAxis());
  symmetric(r.start(), r.end(), xAxis());
  distance(b.start(), b.end(), 80);
  distance(r.start(), r.end(), 60);
});
const e = extrude(20);

section('A-A', 'xz');
section('Mid', 'xy', { offset: 10 });
section('Top', plane(e.endFaces()), { flip: true });
```

`section()` returns a [[api/types/section]].
