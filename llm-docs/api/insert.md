---
id: api/insert
title: "insert(definition, configuration?, overrides?)"
summary: "Places a part or sub-assembly definition in the current assembly and returns a handle — Instance (part) or Occurrence (sub-assembly) — with .translate(), .rotate(), .grounded(), .name(), .transparent() chains, instance.connectors.<name> for mates and instance.features.<name> for tangent mates. A string second argument names a row of the definition's configurations() table (insert(def, 'Wide'), insert(def, 'Wide', { Depth: 1000 })). Overrides feed the definition's param() calls, in the part's own unit."
tags: [api, assembly]
symbols: [insert]
seeAlso: [api/assembly, api/mate, api/part, api/param, api/configurations, api/replicate, concepts/assemblies, concepts/configurations]
---

# insert

Imported from `fluidcad/core`. Only allowed in `*.assembly.js` files.

```ts
insert(definition: PartDefinition, overrides?: Record<string, value>): Instance
insert(definition: PartDefinition, configuration: string, overrides?: Record<string, value>): Instance
insert(definition: Assembly, overrides?: Record<string, value>): Occurrence
insert(definition: Assembly, configuration: string, overrides?: Record<string, value>): Occurrence
```

Places one instance of an exported `part()` or `assembly()` definition. The
first insert of a variant builds it; repeats with the same configuration
and equal overrides share the build.

A **string** second argument names a row of the definition's
`configurations()` table ([[api/configurations]]); the override object then
moves to the third position and layers on top of the row:

```js
insert(frame);                          // Default — the param() literals
insert(frame, "Wide");                  // the Wide row
insert(frame, "Wide", { Depth: 1000 }); // the row, one value changed
insert(frame, { Width: 1200 });         // values only, no row
```

- A name the table does not declare is a build error on this statement,
  listing the declared names. `"Default"` is the same as no name.
- A name on a definition with no `configurations()` table warns and builds
  the literals.
- `insert(def, "Wide")` and `insert(def, { Width: 1200 })` are separate
  builds even when the values agree.
- The name may be any expression that yields a string, e.g. a `select`
  parameter of the parent whose values are the child's row names.
- `insert(def, { … }, { … })` (overrides in both positions) throws: the
  object goes second unless a name comes first.
- The record carries the name: the Parts panel shows `frame · Wide`, and
  the STEP export names the occurrence `frame (Wide)`.

The returned handle chains a starting pose, a name and a display transparency, in any order:

| chain | effect |
|-------|--------|
| `.translate(x, y, z)` | where the instance starts — mates move it from here |
| `.rotate(axis, degrees)` | turn it about a world axis (`'x'`, `'y'`, `'z'` or an axis object) |
| `.grounded()` | pin it; the frame everything else is solved against (one per mechanism) |
| `.name('…')` | the label in the Parts panel and the STEP export |
| `.transparent(v)` | see-through in the assembly view: `0` opaque … `1` fully transparent (no argument = `0.5`); outside 0..1 throws. Display only — pose, mates and export are untouched. On a sub-assembly it fades every part inside (opacities multiply); a replica follows its seed's value |

and exposes the part's interface:

| member | meaning |
|--------|---------|
| `instance.connectors.<name>` | a connector the part declared, bound to this instance — a `mate()` side |
| `instance.connectors.<name>.instance(k)` | copy k of that connector, when the part `copy()`s it — a `mate()` side too |
| `instance.features.<name>` | an `expose()`d face/edge bound to this instance — a `mate('tangent')` side |
| `occurrence.parts` | a sub-assembly's return value, for deep references |

Dragging an instance with the transform gizmo writes `.translate()` /
`.rotate()` back onto the statement; *Toggle grounded* in the Parts panel
adds or removes `.grounded()`; *Transparency…* sets or removes
`.transparent(v)`.

```js
import { assembly, insert, mate } from "fluidcad/core";
import { plate } from "./plate.part.js";
import { extrusion } from "./extrusion.part.js";

export const frame = assembly("frame", () => {
  const base = insert(plate).grounded();
  const post = insert(extrusion, { Length: 380 }).translate(0, 0, 10).name("Post").transparent(0.6);
  mate("fastened", base.connectors.hole1, post.connectors.start);
});
```

Units: a part from a file with a different `unit()` is rescaled into the
assembly's unit at render time, connectors and all. Overrides and
configuration cells are **not** converted — `insert(def, { Length: 10 })`
reads 10 in the part file's unit.
