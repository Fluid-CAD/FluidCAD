---
id: api/mate
title: "mate(type, a, b)"
summary: "Joins two inserted parts with a joint — fastened, revolute, slider, cylindrical, planar (on connectors) or tangent (on exposed geometry). Default placement is face-to-face; chain .flip(), .rotate(deg), .offset(x, y, z), .limits(min, max), .noPropagate()."
tags: [api, assembly, mate]
symbols: [mate]
seeAlso: [api/insert, api/connector, api/expose, api/replicate, concepts/assemblies]
---

# mate

Imported from `fluidcad/core`. Only allowed in `*.assembly.js` files.

```ts
mate(type, a, b): MateBuilder
```

| type | free motion | sides |
|------|-------------|-------|
| `'fastened'` | none | connectors |
| `'revolute'` | rotation about Z | connectors |
| `'slider'` | travel along Z | connectors |
| `'cylindrical'` | rotation about Z + travel along Z | connectors |
| `'planar'` | slide in X and Y + rotation about Z | connectors |
| `'tangent'` | anything that keeps the surfaces in contact | exposures |

A connector side is `instance.connectors.<name>` (from an `insert()`
handle) or an assembly connector; a tangent side is
`instance.features.<name>`. The two kinds are not interchangeable — passing
a connector to `'tangent'` or an exposure to any other type is an error.

**Driver and placement.** The first side drives: options are read in its
connector frame. By default the second connector is placed **face-to-face**
on the first — origins coincide, the second Z points against the first — so
connectors on the touching faces of two parts put the parts on each other.

Chained options:

| chain | meaning | allowed on |
|-------|---------|------------|
| `.flip()` | second Z along the first instead of against it | all lower-pair types |
| `.rotate(deg)` | spin the second frame about the shared Z | all lower-pair types |
| `.offset(x, y, z)` | shift the second origin in the driver's frame | fastened, revolute: any axis; slider, cylindrical, planar: Z only |
| `.limits(min, max)` | bound the free motion (revolute: degrees; slider: document units) | revolute, slider |
| `.noPropagate()` | contact on the picked face only, not its tangent chain | tangent |

Ground exactly one instance per mechanism; the mates carry the rest. Mates
are solved live in the viewport — drag a part and it moves within the
freedom its joints leave; the Joints panel drives revolute and slider
mates (Animate…).

```js
import { assembly, insert, mate } from "fluidcad/core";
import { plate } from "./plate.part.js";
import { lever } from "./lever.part.js";
import { pin } from "./pin.part.js";
import { roller } from "./roller.part.js";

export const mechanism = assembly("mechanism", () => {
  const base = insert(plate).grounded();
  const arm = insert(lever);
  const pivotPin = insert(pin);
  const wheel = insert(roller);

  // hinge: lever on the plate's bore, ±45°
  mate("revolute", base.connectors.bore, arm.connectors.pivot).limits(-45, 45);
  // the pin fastened onto the lever, head seated over the hole
  mate("fastened", arm.connectors.pinSeat, pivotPin.connectors.head);
  // a roller resting on the plate's exposed top face
  mate("tangent", wheel.features.tread, base.features.deck);
});
```

Slider and cylindrical share their axis, so `.offset()` with a non-zero X
or Y is refused on them; planar's X and Y are its free directions, so the
same rule applies. Tangent has no joint frame: `.flip()`, `.rotate()`,
`.offset()` and `.limits()` are refused. Supported tangent surfaces: plane,
cylinder, cone, sphere.
