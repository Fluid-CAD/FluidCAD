---
id: api/chamfer
title: chamfer(distance, ...edges?)
summary: Flat angled break on a 3D edge. Symmetric, asymmetric (d1 × d2), or distance + angle forms.
tags: [api, 3d, modifier, edges]
symbols: [chamfer]
seeAlso: [api/fillet, api/extrude]
---

# chamfer

```ts
chamfer(distance?)                                  // default 1, uses last selection
chamfer(distance, ...sceneObjects)
chamfer(d1, d2, isAngle?)                           // asymmetric or distance + angle
chamfer(d1, d2, isAngle, ...sceneObjects)
```

Returns a `SceneObject`. Operates on the last selection when no edges
are passed, just like [[api/fillet]].

## When to reach for chamfer vs fillet

Chamfers are cheaper computationally and faster to spec from a drawing —
prefer them for manufacturing edge breaks. Save fillets for visually
styled rounds or stress-relief features.

## Example

```fluid.js
sketch("xy", () => rect(60, 40).centered());
const e = extrude(20);
chamfer(2, e.endEdges());
```

See [[api/fillet]] for the rounded counterpart.
