---
id: api/constraint-qualifiers
title: outside / enclosed / enclosing / unqualified
summary: Wrap a geometry to disambiguate which solution a constrained primitive (tLine/tArc/tCircle) should pick.
tags: [api, 2d, constrained, selection]
symbols: [outside, enclosed, enclosing, unqualified]
seeAlso: [api/tline, api/tarc, api/tcircle]
---

# Constraint qualifiers

Imported from `fluidcad/constraints`.

```ts
outside(obj)
enclosing(obj)
enclosed(obj)
unqualified(obj)
```

Constrained primitives like `tLine`, `tArc`, and `tCircle` can produce
multiple valid solutions (e.g., the 4 internal/external tangents between
two circles, or up to 8 tangent circles). These qualifiers wrap a
candidate geometry to narrow which solution is selected.

- `outside(obj)` — the result must be external to `obj` (no shared
  interior).
- `enclosing(obj)` — the result wraps around `obj`.
- `enclosed(obj)` — the result sits inside `obj`.
- `unqualified(obj)` — clears any prior qualification on `obj`.

Importable from `fluidcad/constraints`.

## Example

```fluid.js
import { outside } from "fluidcad/constraints";

sketch("xy", () => {
  const c1 = circle([0, 0], 40).reusable();
  const c2 = circle([100, 0], 40).reusable();
  tLine(outside(c1), outside(c2));      // the external tangent between c1 and c2
});
extrude(2);
```

See [[api/tline]], [[api/tarc]], and [[api/tcircle]] for the primitives
these qualifiers disambiguate.
