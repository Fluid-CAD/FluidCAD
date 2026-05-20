---
id: api/tline
title: tLine — tangent line
summary: Constrained tangent line — between two curves, from the cursor to one curve, or continuing the previous geometry's tangent.
tags: [api, 2d, constrained, curve]
symbols: [tLine]
seeAlso: [api/tarc, api/tcircle, api/cursor-lines]
---

# tLine

```ts
tLine(distance)                                          // continue tangent to previous geometry
tLine(c1: SceneObject, c2: SceneObject, mustTouch?)      // between two objects
tLine(c1: QualifiedGeometry, c2: QualifiedGeometry, mustTouch?)
tLine(c1, mustTouch?)                                    // tangent to one object from cursor
```

Returns `Geometry` (one-arg form) or `TwoObjectsTangentLine` with
`.start()`, `.end()`, and `.tangent()` vertices.

Multiple tangent lines exist between two curves — disambiguate with
`outside()`, `enclosing()`, or `enclosed()` qualifiers (see Phase 11
slice 4 once they land).

## Example

```fluid.js
sketch("xy", () => {
  const c1 = circle([0, 0], 30).reusable();
  const c2 = circle([100, 0], 20).reusable();
  tLine(c1, c2);
});
extrude(2);
```

See [[api/tarc]] for tangent arcs and [[api/tcircle]] for tangent
circles.
