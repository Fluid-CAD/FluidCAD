---
id: api/assembly
title: "assembly(name, callback)"
summary: "Declares a (sub-)assembly — a lazy body of insert() / mate() statements that renders when exported from the entry file and can itself be inserted into another assembly. The body's return value becomes occurrence.parts; param() inside it is the definition's parameter interface."
tags: [api, assembly]
symbols: [assembly]
seeAlso: [api/insert, api/mate, api/part, api/connector, concepts/assemblies]
---

# assembly

Imported from `fluidcad/core`. Only meaningful in `*.assembly.js` files.

```ts
assembly(name: string, callback: () => T): Assembly<T>
```

A new assembly file is scaffolded as one exported definition, and the
Insert wizard and mate dialog write their statements inside its callback:

```js
import { assembly, insert, mate } from "fluidcad/core";
import { plate } from "./plate.part.js";
import { lever } from "./lever.part.js";

export const leverAssembly = assembly("lever-assembly", () => {
  const base = insert(plate).grounded();
  const arm = insert(lever);
  mate("revolute", base.connectors.bore, arm.connectors.pivot).limits(-45, 45);
});
```

The definition is lazy: nothing runs until the entry render runs the
exported one, or a parent `insert(def)` executes the body under a fresh
occurrence scope. A bare `assembly(...)` statement that nothing exports or
inserts renders blank (and says so).

Sub-assemblies:

- The callback's return value is exposed per occurrence as
  `occurrence.parts`, so `stack.parts.arm.connectors.pivot` binds to THAT
  occurrence's lever.
- `.grounded()` inside the body anchors an instance **in the sub-assembly's
  own frame**. The parent decides whether the occurrence itself is grounded;
  only a chain of grounded frames to the root pins anything to the world.
- `param()` inside the body is the sub-assembly's parameter interface;
  `insert(def, { Width: 900 })` resolves it per occurrence.
- Assembly connectors (`connector('name', [x, y, z])`) are root-scope only
  — declare them in the file that inserts the sub-assembly, not in its body.

```js
const pivotArm = assembly("pivot-arm", () => {
  const arm = insert(lever).grounded();        // anchor of THIS frame
  const pivotPin = insert(pin);
  mate("fastened", arm.connectors.pinSeat, pivotPin.connectors.head);
  return { arm, pivotPin };
});

export const mechanism = assembly("mechanism", () => {
  const base = insert(plate).grounded();
  const swing = insert(pivotArm).translate(0, 0, 40);
  mate("revolute", base.connectors.bore, swing.parts.arm.connectors.pivot);
});
```

Units: an assembly never declares a unit. Its lengths are in the project
unit; inserted parts are scaled from their file's unit into it.
