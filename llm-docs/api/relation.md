---
id: api/relation
title: "relation(type, a, b, ratio)"
summary: "Couples the free motions of two mates like meshing gears — 'gear' ties two rotations (revolute / cylindrical), 'rack-and-pinion' a rotation to a slide (slider / cylindrical). Chain .reverse() to run the second mate the other way, .name() for a stable name."
tags: [api, assembly, mate, relation, gear]
symbols: [relation]
seeAlso: [api/mate, api/insert, api/connector, concepts/assemblies]
---

# relation

Imported from `fluidcad/core`. Only allowed in `*.assembly.js` files.

```ts
relation(type, a, b, ratio): RelationBuilder
```

A relation couples the free motion of two mates: turn one and the other
turns (or slides) by the ratio. Both mates keep their own freedom — dragging
either part, or animating either joint from the Joints panel, moves both.

| type | `a` (measured) | `b` (follows) | `ratio` |
|------|----------------|---------------|---------|
| `'gear'` | revolute or cylindrical — its rotation about Z | revolute or cylindrical — its rotation about Z | turns of `b` per turn of `a` |
| `'rack-and-pinion'` | revolute or cylindrical — the pinion's rotation | slider or cylindrical — the rack's travel along Z | travel of `b` (document units) per revolution of `a` |

`a` and `b` are `mate()` handles — bind each mate to a `const` and pass it.
Each rotation is measured about its own mate's Z axis (the first connector's
normal), each travel along it. The ratio is positive; a positive ratio moves
`b` in the same sense as `a`. Chain `.reverse()` when the real parts run the
other way — two external spur gears on parallel axes counter-rotate, so a
gear pair whose connectors both point the same way needs it.

The relation holds from wherever the parts stand when it is solved: the
file's poses set the mesh phase. A planar mate has no single travel to
couple (it frees two directions and a spin), so a rack sits on a slider.

Chained options:

| chain | meaning |
|-------|---------|
| `.reverse()` | `b` moves against `a`'s sense |
| `.name(name)` | stable authored name, unique within the owning assembly occurrence |

Both mates must be declared in the same assembly scope as the relation
(the same `assembly()` body, or both at the file's top level).

```js
import { assembly, insert, mate, relation } from "fluidcad/core";
import { plate } from "./plate.part.js";
import { gear } from "./gear.part.js";
import { rack } from "./rack.part.js";

export const drive = assembly("drive", () => {
  const base = insert(plate).grounded();
  const pinion = insert(gear, { teeth: 12 });
  const wheel = insert(gear, { teeth: 24 });
  const bar = insert(rack);

  const pinionAxle = mate("revolute", base.connectors.axle1, pinion.connectors.bore);
  const wheelAxle = mate("revolute", base.connectors.axle2, wheel.connectors.bore);
  const slide = mate("slider", base.connectors.rail, bar.connectors.slot);

  // 12 teeth drive 24: the wheel makes half a turn per pinion turn, the other way.
  relation("gear", pinionAxle, wheelAxle, 0.5).reverse();
  // A 20 mm pitch radius moves the rack 2π·20 ≈ 125.66 mm per pinion turn.
  relation("rack-and-pinion", pinionAxle, slide, 125.66);
});
```

In the viewport, the assembly toolbar's **Gear** and **Rack** buttons open
the relation dialog: pick the two joints from the **Joints** panel (or click
a part carrying one), set the ratio, tick **Reverse** if needed, and the
parts turn together while the dialog is open — Apply writes the statement.
Relation rows in the Joints panel show a red dot when a solve could not
hold the ratio (a coupled joint is held, say).
