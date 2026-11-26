---
id: api/load
title: load(fileName)
summary: "Loads an imported STEP file (its cache in imports/) into the scene: its solids, its surfaces (faces that enclose no volume) and its curves (edges that bound no face), with the face colours of solids and surfaces. .include(i) / .exclude(i) count solids first, then surfaces, then curves; .noColors() drops the colours. A cache that holds only solids gains the surfaces and curves when the file is imported again. STEP export writes solids and surfaces; STL, DXF and SVG write solids only and warn about the surfaces they leave out; curves are never exported. Returns a transformable SceneObject."
tags: [api, utility, io]
symbols: [load]
seeAlso: [api/translate, api/rotate, concepts/units, concepts/packages]
---

# load

Imported from `fluidcad/core`.

```ts
load(fileName: string, options?: { unit?: string; from?: 'package' | 'project' }): ILoadFile
```

Loads an imported STEP file by name. Importing a STEP file (the Import
button, or the MCP `import_step` tool) caches it as `imports/<name>.brep`
with a colour sidecar and appends `load('<name>')` to the current file.
`fileName` is that name, with or without `.step` / `.stp`. The result is a
SceneObject you can transform like any other (`.translate(...)`,
`.rotate(...)`, `.mirror(...)`).

## What a file brings

| In the STEP file | In the scene |
|---|---|
| Solids | one solid each |
| Surfaces: connected faces that enclose no volume | one surface each, with its open rim |
| A face on its own | a surface of one face |
| Curves: edges that bound no face | one curve each |
| Face colours | kept on solids and surfaces |
| Loose points, annotations | not imported |

A STEP file stores a multi-edge curve as separate edges, so a curve drawn
as one chain elsewhere arrives as one curve per edge.

The cache is what the file held when it was imported. A cache that holds
only solids gains the file's surfaces and curves when the file is
imported again; until then `load()` adds its solids alone.

## Picking what to load

- `.include(...indices)` keeps only the shapes at those 0-based indices.
- `.exclude(...indices)` drops them (applied after `include`).
- Indices count every solid of the file first, then every surface, then
  every curve, so a solid keeps its index whatever else the file holds.
- `.noColors()` loads the geometry without the file's colours.

## Options

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

## Export

STEP export writes solids and surfaces, with their colours. STL, DXF and
SVG write the solids only and add a warning naming the surfaces they left
out ("1 surface left out: a surface encloses no volume."); asking them for
surfaces alone is refused with a hint to export as STEP. Curves are never
exported.

## Example

```js
load("bracket.step")
  .translate(0, 0, 50)
  .rotate("z", 90);

// Only the first solid of a file, without its colours.
load("motor").include(0).noColors();
```

(Skipped from runtime testing — requires a workspace file.)

See [[api/translate]] / [[api/rotate]] for follow-up positioning.
