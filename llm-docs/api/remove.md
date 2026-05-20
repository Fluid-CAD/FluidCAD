---
id: api/remove
title: remove(...objects)
summary: Deletes scene objects. Most useful after `.reusable()` once a profile is no longer needed.
tags: [api, utility]
symbols: [remove]
seeAlso: [api/sketch]
---

# remove

```ts
remove(...objects: SceneObject[])
```

Removes objects from the scene. The common pattern is cleaning up a
`.reusable()` profile once every consumer has been built.

## Example

```fluid.js
const profile = sketch("xy", () => circle(40)).reusable();
extrude(20);
extrude(40);
remove(profile);                                 // clean up the profile
```

See [[api/sketch]] for `.reusable()`.
