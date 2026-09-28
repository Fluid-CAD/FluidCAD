---
id: api/property
title: "property(name, value, kind?)"
summary: "Publishes a value a part computes from its parameters under a name. An assembly reads instance.properties.name (that instance's own values), another part reads def.properties.name (the default variant). Plain numbers/strings/booleans/arrays only — never geometry, never a measurement of the built shapes."
tags: [api, part, assembly]
symbols: [property]
seeAlso: [api/part, api/param, api/insert, api/expose, concepts/assemblies]
---

# property

Imported from `fluidcad/core`.

```ts
property(name: string, value: number | string | boolean | (number | string)[], kind?: 'length'): value
```

The part's value interface — the outbound twin of `param()`: a parameter
is a value the part takes in, a property is a value it hands out, computed
from those parameters. `connector()` does the same for mate frames and
`expose()` for geometry.

- **An assembly** reads `instance.properties.<name>` on an inserted
  instance and gets the values that instance's own overrides produced:
  `insert(plate, { Width: b.properties.internalWidth })`,
  `.translate(0, 0, b.properties.floorHeight)`.
- **Another part** reads `def.properties.<name>` on the definition and
  gets the default variant's values.

Values are plain, so they go anywhere a number goes. The statement returns
the value, so `const w = property('w', width - 2 * wall)` declares a local
and publishes it in one line. Reading a name the part never declared
throws an error listing the declared names — never `undefined`.

`kind: 'length'` marks a number (or number array) as a length in the part
file's unit; a consumer running in another unit reads it rescaled (an inch
part's `0.5` reads `12.7` in a millimetre assembly). Untagged values are
handed over verbatim, like a `param()` override.

Rules: call it inside a `part()` body (anywhere in it, like `param()`);
names are unique within a part; the value must be a number, string,
boolean or array of numbers/strings. Nothing is built while the body runs,
so a property is arithmetic over parameters — it cannot measure the part's
geometry (a bounding box, a volume). Geometry is published with `expose()`.

## Example

```fluid.js
import { part, param, sketch, circle, extrude, cut, plane, property, origin } from "fluidcad/core";
import { coincident, diameter } from "fluidcad/constraints";

// A round housing with a pocket: the pocket's size is what a mating part
// has to fit, so the housing publishes it instead of leaving consumers to
// redo the arithmetic.
const housing = part("Housing", () => {
  const width = param("Width", 60);
  const wall = param("Wall", 4);
  const height = param("Height", 25);

  sketch("xy", () => {
    const c = circle([0, 0], width);
    coincident(c.center(), origin());
    diameter(c, width);
  });
  extrude(height);
  sketch(plane("xy", { offset: height }), () => {
    const c = circle([0, 0], width - 2 * wall);
    coincident(c.center(), origin());
    diameter(c, width - 2 * wall);
  });
  cut(height - wall);   // down into the body, leaving the floor

  property("pocketDiameter", width - 2 * wall, "length");
  property("pocketDepth", height - wall, "length");
  property("boltCount", 4);
});

// A plug sized from the housing's published pocket (default variant).
const plug = part("Plug", () => {
  const d = housing.properties.pocketDiameter - 0.4;   // 0.2 mm clearance per side
  sketch(plane("xy", { offset: 90 }), () => {
    const c = circle([0, 0], d);
    coincident(c.center(), origin());
    diameter(c, d);
  });
  extrude(housing.properties.pocketDepth);
});
```

In an assembly file, each instance carries its own values:

```js
const wide = insert(housing, { Width: 100 }).grounded();
const narrow = insert(housing, { Width: 50 }).translate(120, 0, 0);
wide.properties.pocketDiameter;     // 92
narrow.properties.pocketDiameter;   // 42
insert(plate, { Width: wide.properties.pocketDiameter - 0.4 })
  .translate(0, 0, wide.properties.pocketDepth);
```
