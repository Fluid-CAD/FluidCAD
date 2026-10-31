---
id: api/load
title: load(fileName)
summary: Imports a 3D model file (STEP, STL, etc.) from the project folder. Returns a Transformable SceneObject.
tags: [api, utility, io]
symbols: [load]
seeAlso: [api/translate, api/rotate, concepts/packages]
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

Options (`load(fileName, options)`):

- `unit` — asserts the unit the cached geometry is in; only for assets
  without trustworthy metadata (imports are cached in mm and scaled into the
  loading file's unit automatically).
- `from` — `'package'` (default) reads `imports/` beside the file the call
  is written in: an installed package's own `imports/` (pack ships it) for a
  call in a package's file, the project's for a call in the project's own
  files. `'project'` reads the project using the package, whatever file the
  call is in — how a package part loads a STEP name its user passes in. A
  package's missing asset fails ("Imported asset not found:
  imports/mine.brep in @acme/labels@1.2.0. If the name comes from the model
  using the package, read it with load(name, { from: 'project' }).") and is
  never looked for in the project. See [[concepts/packages]].

## Example

```js
load("bracket.step")
  .translate(0, 0, 50)
  .rotate("z", 90);
```

(Skipped from runtime testing — requires a workspace file.)

See [[api/translate]] / [[api/rotate]] for follow-up positioning.
