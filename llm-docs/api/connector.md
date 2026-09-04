---
id: api/connector
title: "connector(name, source, options?) / connector(name, [x, y, z])"
summary: "Declares a named mate frame. Inside part() it is attached to real geometry (a face, edge, vertex, anchored vertex or plane) and appears on every instance as instance.connectors.name; at the top level of an assembly file it is a free frame at a world point. Chain .offset(x, y, z) and .rotate(axis, deg) to move it in its own axes."
tags: [api, part, assembly, mate]
symbols: [connector]
seeAlso: [api/mate, api/part, api/insert, api/select, concepts/assemblies]
---

# connector

Imported from `fluidcad/core`.

```ts
connector(name: string, source: SceneObject, options?: { xDirection?: AxisLike }): Connector   // inside part()
connector(name: string, position: [x, y, z]): Connector                                        // assembly top level
```

A connector is a coordinate frame — origin, X direction, Z normal — that
`mate()` joins to another connector. Part connectors are the part's mating
interface; every instance carries the same set, reached as
`instance.connectors.<name>`.

Where the frame comes from:

| source | origin | Z |
|--------|--------|---|
| planar face — `select(face().onPlane('xy', 10))` | face centre | outward normal |
| circular edge — `select(edge().circle(8))` | circle centre | circle axis |
| straight edge — `select(edge().line())` | edge midpoint | edge tangent |
| vertex | the point | world Z |
| anchored vertex — `e.endFaces().center()`, `sel.start()` | the anchor | the face / edge direction |
| plane — `plane('-xy')` | plane origin | plane normal |

The source must resolve to exactly one face, edge or vertex; a raw point is
refused inside a part (frames must re-derive from geometry). Chain
`.offset(x, y?, z?)` (translate along the frame's own axes) and
`.rotate('x' | 'y' | 'z', degrees)` (turn about its own axis) in call order.

Rules: declare connectors **directly in the part body** (not in a nested
callback); names are unique within a part. Face frames point Z out of the
solid, and a mate aligns two Zs against each other by default — so
connectors on the touching faces of two parts mate face-to-face.

The assembly-level form, `connector('name', [x, y, z])` at the top level of
a `*.assembly.js` file, is a free frame in the assembly's space with world
axes at the point; it is a mate side in its own right (root scope only).

## Example

```fluid.js
import { part, sketch, circle, extrude, chamfer, select, connector } from "fluidcad/core";
import { face } from "fluidcad/filters";

const pin = part("Pivot pin", () => {
  sketch("xy", () => {
    circle([0, 0], 8);
  });
  const shaft = extrude(-18);
  sketch("xy", () => {
    circle([0, 0], 12);
  });
  extrude(3);
  chamfer(1, shaft.endEdges());

  // Under the head: seats on whatever the pin goes through.
  connector("head", select(face().planar().onPlane("xy", 0)));
  // The tip face, Z pointing out of the pin.
  connector("tip", shaft.endFaces());
});
```

A frame moved to a hole on a face, then an assembly connector:

```js
// plate.part.js — the top-face frame moved along its own X / Y to a hole
connector("hole1", select(face().planar().onPlane("xy", 10))).offset(-30, -17.5, 0);

// mechanism.assembly.js — a free frame, turned to face down
const mount = connector("mount", [0, 0, 40]).rotate("x", 180);
mate("fastened", mount, base.connectors.top);
```
