---
id: api/remove
title: remove(...objects)
summary: Deletes scene objects. Takes a `.reusable()` layout sketch or selection off the screen, or drops a sketch from later feature reads.
tags: [api, utility]
symbols: [remove]
seeAlso: [api/sketch]
---

# remove

Imported from `fluidcad/core`.

```ts
remove(...objects: SceneObject[])
```

Removes objects from the scene for good: off the screen and out of every
later feature's reach. A sketch does not need it after use — its consumer
already hides it — so `remove()` is for the objects that stay on purpose:
a `.reusable()` layout sketch or a `.reusable()` selection once nothing
else draws against it.

## Example

```fluid.js
import { circle, extrude, origin, remove, sketch } from "fluidcad/core";
import { coincident, diameter } from "fluidcad/constraints";

const layout = sketch("xy", () => {
  const c = circle([0, 0], 40);
  coincident(c.center(), origin());
  diameter(c, 40);
}).reusable();                                   // stays on screen
extrude(20, layout);
extrude(40, layout);
remove(layout);                                  // off the screen from here
```

See [[api/sketch]] for `.reusable()`.
