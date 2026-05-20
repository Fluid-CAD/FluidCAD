---
id: api/booleans
title: fuse / subtract / common
summary: Explicit 3D boolean operations. Most of the time auto-fusion does the right thing — reach for these when you need exact control.
tags: [api, 3d, boolean]
symbols: [fuse, subtract, common]
seeAlso: [api/extrude, api/cut, concepts/scene-graph]
---

# fuse / subtract / common

```ts
fuse()
fuse(...objects)                       // union of objects
subtract(object1, object2)             // object1 − object2
common()
common(...objects)                     // intersection
```

The no-argument forms operate on the implicit last objects in scope; the
explicit forms operate on the arguments you pass. Most modeling work can
rely on auto-fusion (touching solids merge automatically and `.remove()`
chained on `extrude` already covers subtraction). Reach for these when:

- You need to fuse non-touching solids deliberately.
- An op didn't auto-fuse the way you wanted and you want to be explicit.
- You want an explicit intersection rather than a per-feature `.scope()`.

## Example

```fluid.js
sketch("xy", () => rect(60, 60).centered());
const a = extrude(20).new();
sketch("xy", () => circle(35));
const b = extrude(20).new();
subtract(a, b);
```

See [[api/extrude]] for chained boolean scope (`.add()`, `.remove()`,
`.new()`, `.scope()`) and [[api/cut]] for the subtractive extrude.
