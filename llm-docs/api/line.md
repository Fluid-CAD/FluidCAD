---
id: api/line
title: line(start, end)
summary: Straight 2D line on the active sketch plane. The endpoints are solver guesses — constrain .start()/.end()/.mid() to make them exact.
tags: [api, 2d, primitive]
symbols: [line]
seeAlso: [api/sketch, api/arc, api/constraints]
---

# line

Imported from `fluidcad/core`.

```ts
line(start: Point2D, end: Point2D)
```

Returns a solved line entity. The literal coordinates are **guesses** —
under-constrained geometry stays exactly where you drew it, and
constraints move it to the exact answer. Accessors for constraint
targets: `.start()`, `.end()`, `.mid()`. Chain `.guide()` to make the
line a construction line (visible, constrainable, excluded from
profiles).

Join consecutive segments with `coincident(prev.end(), next.start())`;
orient them with `horizontal` / `vertical` / `angle`; size them with
`distance`.

## Example

```fluid.js
import { extrude, line, sketch } from "fluidcad/core";
import { coincident, horizontal, vertical, fix, distance } from "fluidcad/constraints";

sketch("xy", () => {
  const b = line([0, 0], [40, 0]);
  const r = line([40, 0], [40, 30]);
  const t = line([40, 30], [0, 30]);
  const l = line([0, 30], [0, 0]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(b);
  vertical(r);
  horizontal(t);
  vertical(l);
  fix(b.start(), [0, 0]);
  distance(b.start(), b.end(), 40);
  distance(r.start(), r.end(), 30);
});
extrude(5);
```

Exact coordinates alone also work — a loop of lines whose endpoints
already touch forms a closed profile without any constraints; add
constraints when you want the sketch driven by relationships instead of
arithmetic.

See [[api/constraints]] for the constraint catalog and [[api/arc]] for
curved segments.
