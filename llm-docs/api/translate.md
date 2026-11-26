---
id: api/translate
title: translate(x, y?, z?, ...targets?)
summary: "Moves solids, surfaces and curves by a vector. With no targets, moves every solid and surface in scope (curves stay put); a named target moves its bodies and the curves it holds. Pass `copy: true` to clone instead of moving."
tags: [api, 3d, transform]
symbols: [translate]
seeAlso: [api/rotate, api/mirror, api/copy]
---

# translate

Imported from `fluidcad/core`.

```ts
translate(x, ...targets)
translate(x, y, ...targets)
translate(x, y, z, ...targets)
translate(point: PointLike, ...targets)
translate(x, y, z, copy: boolean, ...targets)    // copy flag at any arity
```

Returns the translated `SceneObject`.

**What moves.** With no targets, every body in scope moves — solids and
surfaces (an imported STEP surface from [[api/load]]) alike. Curves never
move unless named. A named target moves its bodies and the curves it
holds: naming a helix, a loaded curve or a sketch moves its curves. Meta
and guide shapes (a plane's quad, a guide sketch) never move. A named
target that holds only something else — a face selection, a point — is a
build error: `translate: target 1 is a face selection; translate works on
solids or surfaces or curves.` [[api/rotate]] reads targets by the same
rule; [[api/mirror]] reads named targets the same way.

A named target stands for the body it built wherever later features left
it: after `const e = extrude(30); fillet(3, e.endEdges());` the call
`translate([0, 0, 100], e)` moves the filleted body (see
[[concepts/scene-graph]]). Only a body nothing stands for any more — one
`remove()` took, or a cut consumed entirely — makes the move fail.

The `copy: true` overload duplicates the source rather than moving it,
producing a new independent object. Use it for one-off duplicates; for
patterns use [[api/copy]] or [[api/repeat]].

## Example

```fluid.js
import { sphere, translate } from "fluidcad/core";

const s = sphere(15);
translate(0, 0, 60, s);                          // lift the sphere by 60
```

See [[api/rotate]] for rotations and [[api/copy]] for snapshot
duplication patterns.
