---
id: api/load
title: load(fileName)
summary: Imports a 3D model file (STEP, STL, etc.) from the project folder. Returns a Transformable SceneObject.
tags: [api, utility, io]
symbols: [load]
seeAlso: [api/translate, api/rotate]
---

# load

Imported from `fluidcad/core`.

```ts
load(fileName: string)
```

Imports an external 3D file by relative filename. Returns a SceneObject
you can transform like any other (`.translate(...)`, `.rotate(...)`,
`.mirror(...)`).

Supported formats include STEP and STL. The returned `ILoadFile` may
expose `.noColors()`, `.include(...)`, and `.exclude(...)` to control
sub-shape selection and STEP colour import — consult the codebase for
exact behaviour.

## Example

```js
load("bracket.step")
  .translate(0, 0, 50)
  .rotate("z", 90);
```

(Skipped from runtime testing — requires a workspace file.)

See [[api/translate]] / [[api/rotate]] for follow-up positioning.
