---
id: api/insert
title: "insert(definition, overrides?)"
summary: "Places a part or sub-assembly definition in the current assembly and returns a handle — Instance (part) or Occurrence (sub-assembly) — with .translate(), .rotate(), .grounded(), .name() chains, instance.connectors.<name> for mates and instance.features.<name> for tangent mates. Overrides feed the definition's param() calls, in the part's own unit."
tags: [api, assembly]
symbols: [insert]
seeAlso: [api/assembly, api/mate, api/part, api/param, api/replicate, concepts/assemblies]
---

# insert

Imported from `fluidcad/core`. Only allowed in `*.assembly.js` files.

```ts
insert(definition: PartDefinition, overrides?: Record<string, value>): Instance
insert(definition: Assembly, overrides?: Record<string, value>): Occurrence
```

Places one instance of an exported `part()` or `assembly()` definition. The
first insert of a variant builds it; repeats with equal overrides share the
build.

The returned handle chains a starting pose and a name, in any order:

| chain | effect |
|-------|--------|
| `.translate(x, y, z)` | where the instance starts — mates move it from here |
| `.rotate(axis, degrees)` | turn it about a world axis (`'x'`, `'y'`, `'z'` or an axis object) |
| `.grounded()` | pin it; the frame everything else is solved against (one per mechanism) |
| `.name('…')` | the label in the Parts panel and the STEP export |

and exposes the part's interface:

| member | meaning |
|--------|---------|
| `instance.connectors.<name>` | a connector the part declared, bound to this instance — a `mate()` side |
| `instance.features.<name>` | an `expose()`d face/edge bound to this instance — a `mate('tangent')` side |
| `occurrence.parts` | a sub-assembly's return value, for deep references |

Dragging an instance with the transform gizmo writes `.translate()` /
`.rotate()` back onto the statement; *Toggle grounded* in the Parts panel
adds or removes `.grounded()`.

```js
import { assembly, insert, mate } from "fluidcad/core";
import { plate } from "./plate.part.js";
import { extrusion } from "./extrusion.part.js";

export const frame = assembly("frame", () => {
  const base = insert(plate).grounded();
  const post = insert(extrusion, { Length: 380 }).translate(0, 0, 10).name("Post");
  mate("fastened", base.connectors.hole1, post.connectors.start);
});
```

Units: a part from a file with a different `unit()` is rescaled into the
assembly's unit at render time, connectors and all. Overrides are **not**
converted — `insert(def, { Length: 10 })` reads 10 in the part file's unit.
