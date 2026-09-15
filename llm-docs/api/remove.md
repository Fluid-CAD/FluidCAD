---
id: api/remove
title: remove(...objects)
summary: Deletes scene objects. Most useful after `.reusable()` once a profile is no longer needed.
tags: [api, utility]
symbols: [remove]
seeAlso: [api/sketch]
---

# remove

Imported from `fluidcad/core`.

```ts
remove(...objects: SceneObject[])
```

Removes objects from the scene. The common pattern is cleaning up a
`.reusable()` profile once every consumer has been built.

## Example

```fluid.js
import { circle, extrude, origin, remove, sketch } from "fluidcad/core";
import { coincident, diameter } from "fluidcad/constraints";

const profile = sketch("xy", () => {
  const c = circle([0, 0], 40);
  coincident(c.center(), origin());
  diameter(c, 40);
}).reusable();
extrude(20);
extrude(40);
remove(profile);                                 // clean up the profile
```

See [[api/sketch]] for `.reusable()`.
