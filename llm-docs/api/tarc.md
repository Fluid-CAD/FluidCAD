---
id: api/tarc
title: tArc — tangent arc
summary: The most flexible constrained primitive. Tangent-continues from the previous geometry; can target a point, a curve, or thread between two curves.
tags: [api, 2d, constrained, curve]
symbols: [tArc]
seeAlso: [api/tline, api/tcircle, api/arc]
---

# tArc

```ts
tArc(target: SceneObject | QualifiedGeometry)            // ends tangent to target curve
tArc(radius, target)                                     // arc of given radius to target
tArc(radius?, endAngle?)                                 // defaults: radius 100, sweep 90°
tArc(radius, angle, tangent: Point2D)                    // explicit start tangent
tArc(endPoint: Point2D)                                  // tangent arc to a point
tArc(endPoint, tangent)                                  // with end tangent
tArc(startPoint, endPoint, tangent)
tArc(c1: SceneObject, c2: SceneObject, radius, mustTouch?)
tArc(c1: Point2D, c2: Point2D, radius, mustTouch?)
```

Defaults: radius `100`, end angle `90°`. Negative radius flips sweep
direction. Chain `.flip()` to curve to the right of the start tangent
instead of the left.

## Example

```fluid.js
sketch("xy", () => {
  hLine(40);
  tArc(20, 180);            // half-circle of radius 20, tangent to the hLine
  hLine(-40);
  connect();
});
extrude(3);
```

See [[api/tline]] for tangent lines and [[api/arc]] for unconstrained
arcs.
