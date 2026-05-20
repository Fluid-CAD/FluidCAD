---
id: api/shell
title: shell(thickness, ...openFaces?)
summary: Hollows a solid into a thin wall. Pass faces to remove (open the shell). Negative thickness shells inward; positive shells outward.
tags: [api, 3d, modifier]
symbols: [shell]
seeAlso: [api/extrude, api/fillet]
---

# shell

```ts
shell(thickness?)                      // default thickness 2.5, walls inward (negative)
shell(thickness, ...selections)        // remove these faces (open the shell)
```

Returns `Shell` with:

- `.internalFaces()`, `.internalEdges()` — the new inner wall geometry.
- `.join(type)` — corner join style: `"arc"` (default), `"intersection"`
  (sharp), or `"tangent"`.

**Sign of thickness matters.** Negative thickness shells inward
(preserving the outer shape and hollowing out the interior). Positive
shells outward (preserving the inner shape and adding wall material).

## Example

```fluid.js
sketch("xy", () => rect(80, 60).centered());
const e = extrude(40);
const s = shell(-2, e.endFaces());     // open-top container, 2mm walls
fillet(0.5, s.internalEdges());
```

See [[api/extrude]] for the base solid and [[api/fillet]] for refining
the new inner edges.
