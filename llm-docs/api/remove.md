---
id: api/remove
title: remove(...objects)
summary: Deletes scene objects for good. Drops a used sketch, plane or axis from later feature reads and from the scrubbed timeline.
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
later feature's reach. A sketch, a plane or an axis does not need it after
use — its consumer already hides it, and later features may still take it
— so `remove()` is for dropping one once nothing else will draw against
it: it no longer comes back when the timeline is scrubbed and no later
feature can pick it up.

## Example

```fluid.js
import { circle, extrude, origin, remove, sketch } from "fluidcad/core";
import { coincident, diameter } from "fluidcad/constraints";

const layout = sketch("xy", () => {
  const c = circle([0, 0], 40);
  coincident(c.center(), origin());
  diameter(c, 40);
});
extrude(20, layout);                             // hides the sketch
extrude(40, layout);                             // takes it again
remove(layout);                                  // gone for good from here
```

See [[api/sketch]] for how a used sketch stays available.
