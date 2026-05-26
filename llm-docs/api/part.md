---
id: api/part
title: part(name, callback)
summary: Isolation boundary for assembly modeling. Shapes inside a part only auto-fuse with each other, never with siblings outside.
tags: [api, utility, assembly]
symbols: [part]
seeAlso: [concepts/scene-graph]
---

# part

Imported from `fluidcad/core`.

```ts
part(name: string, callback: () => void)
```

Creates an isolation boundary. Shapes inside the callback auto-fuse with
each other but **not** with siblings outside the part. Reach for `part`
when you have multiple distinct components in one assembly file.

Wrapping `part(...)` in a function gives parametric, reusable parts.

## Example

```fluid.js
import { cylinder, extrude, part, rect, sketch } from "fluidcad/core";

part("base", () => {
  sketch("xy", () => rect(120, 80).centered());
  extrude(20);
});

part("pillar", () => {
  cylinder(15, 50).translate(0, 0, 20);
});
```

See [[concepts/scene-graph]] for how parts compose with the rest of the
feature tree.
