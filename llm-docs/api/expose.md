---
id: api/expose
title: "expose(name, source)"
summary: "Publishes a piece of a part's geometry under a name. Consumers read the source as def.features.name (another part builds on it) or instance.features.name (a tangent mate touches it). Accepts a sketch, a face/edge selection, a plane, an axis or a feature — never a raw value."
tags: [api, part, assembly]
symbols: [expose]
seeAlso: [api/part, api/mate, api/connector, api/select]
---

# expose

Imported from `fluidcad/core`.

```ts
expose(name: string, source: SceneObject): SceneObject
```

The outbound half of a part's interface: `param()` takes values in,
`connector()` hands mate frames out, `expose()` hands geometry out.

- **Another part** builds on it as `def.features.<name>`:
  `cut(2, flange.features.holes)`, `project(flange.features.rim)`.
- **A tangent mate** touches it as `instance.features.<name>`:
  `mate('tangent', wheel.features.tread, deck.features.deck)`.

The exposure is a pass-through: it consumes nothing and emits no shape.
Consumers read the **source** object, so a change to the donor flows
through on the next render. A published `select()` stops rendering its
highlight once the statement has run.

Rules: declare exposures **directly in the part body**; names are unique
within a part; the source must be a scene object (a sketch consumed by a
feature needs `.reusable()` to still be there to publish).

## Example

```fluid.js
import { part, sketch, circle, extrude, cut, plane, select, expose, origin } from "fluidcad/core";
import { coincident, diameter, distance, horizontal, vertical } from "fluidcad/constraints";
import { face } from "fluidcad/filters";

const flange = part("Flange", () => {
  sketch("xy", () => {
    const c = circle([0, 0], 60);
    coincident(c.center(), origin());
    diameter(c, 60);
  });
  extrude(6);
  const holes = sketch("xy", () => {
    const bore = circle([0, 0], 20);
    coincident(bore.center(), origin());
    diameter(bore, 20);
    const east = circle([22, 0], 6);
    const north = circle([0, 22], 6);
    const west = circle([-22, 0], 6);
    const south = circle([0, -22], 6);
    horizontal(origin(), east.center());
    horizontal(origin(), west.center());
    vertical(origin(), north.center());
    vertical(origin(), south.center());
    for (const bolt of [east, north, west, south]) {
      distance(origin(), bolt.center(), 22);
      diameter(bolt, 6);
    }
  }).reusable();
  cut(-6, holes);

  expose("holes", holes);
  expose("seal", select(face().planar().onPlane("xy", 6)));
});

// Another part cuts the flange's own hole pattern: a gasket 6 mm below it.
const gasket = part("Gasket", () => {
  sketch(plane("xy", { offset: -6 }), () => {
    const c = circle([0, 0], 60);
    coincident(c.center(), origin());
    diameter(c, 60);
  });
  extrude(-2);
  cut(8, flange.features.holes);   // the sketch is on the flange's plane, 6 above
});
```
