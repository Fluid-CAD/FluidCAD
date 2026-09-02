---
id: concepts/units
title: Units — document units, unit(), and the fluidcad/units helpers
summary: Numbers in a file are in that file's unit; default mm. unit('in') at the top of a part file (top-level, before any geometry, once, literal string) sets it; "unit" in fluidcad.json sets the project default. Units belong to parts — unit() in *.assembly.js is an error; assembly lengths are in the project unit and inserted parts are scaled automatically. inch()/mm()/cm()/m()/ft() from fluidcad/units convert one value into the calling file's unit.
tags: [concept, geometry, units]
symbols: [unit]
seeAlso: [concepts/coordinate-system, api/load, api/part, api/fillet, api/chamfer, api/text]
---

# Units

## The rule

- **Numbers in a file are in that file's unit.** There is no scale factor
  between source and geometry: `extrude(30)` is 30 of whatever the file's
  unit is.
- **Default is `mm`.** A file with no `unit()` in a project with no
  `"unit"` in `fluidcad.json` is millimetres.
- Supported units: `mm`, `cm`, `m`, `in`, `ft`. Aliases (`'inch'`,
  `'inches'`, `'millimeter'`, `'feet'`, …) are accepted.

Resolution for a file, first match wins:

1. `unit('…')` in that file.
2. `"unit"` in the nearest `fluidcad.json`.
3. `mm`.

## `unit()` — per-file declaration

```js
import { unit, sketch, circle, extrude } from 'fluidcad/core';

unit('in');                 // canonical codes: 'mm' | 'cm' | 'm' | 'in' | 'ft'

sketch("xy", () => {
    circle([0, 0], 2);      // 2 in
});
extrude(0.75);              // 0.75 in
```

Signature: `unit(name: string): void`. Imported from `fluidcad/core`.

Rules — each violation is a compile error at the statement:

1. **Top level only.** Not inside `part()`, `sketch()`, `assembly()` or any
   function.
2. **Before any geometry from the same file.** Directly after the imports;
   above `param()` declarations.
3. **Once per file.**
4. **Literal string argument.** `unit('in')`, never `unit(someVar)`.
5. **Part files only.** `unit()` in a `*.assembly.js` file is an error.

`unit()` is not a timeline row: it produces no SceneObject, cannot be a
rollback point, and does not show in the feature tree.

It applies to the file it is written in, including every `part()`
definition that file exports. Importing a file does **not** import its
unit; each file resolves its own.

## Project default — `fluidcad.json`

```json
{ "engine": "0.0.42", "unit": "in" }
```

`npx fluidcad init --unit in` writes it. This is the unit of every part
file without `unit()` and the unit of assembly space. Edits take effect
on the next render.

`init({ unit: 'in' })` in `init.js` is a programmatic override for hosts
and tests. Do not reach for it in a normal project — use `fluidcad.json`.

## Converting one value — `fluidcad/units`

```js
import { sketch, circle, extrude } from 'fluidcad/core';
import { inch, mm, cm, m, ft } from 'fluidcad/units';

// in an mm file:
sketch("xy", () => {
    circle([0, 0], inch(0.25));   // 6.35
});
extrude(inch(1));                 // 25.4
```

Each helper converts its argument **into the unit of the file that calls
it**: `inch(1)` is `25.4` in an mm file, `1` in an inch file, `0.0254` in
a metre file. Use them for the single odd dimension instead of switching
the whole file's unit. `in` is a reserved word, hence `inch`. They throw
outside a render.

## Feature defaults do not scale

Defaults are plain numbers in document units: `fillet()` default radius 1,
`chamfer()` default 1, `text()` default size 10, default extrude height,
etc. In an inch file `fillet(e.endEdges())` is a 1 in fillet. Always pass
the size you mean when the file is not in mm.

## Units belong to parts — the assembly invariant

- `unit()` is an error in `*.assembly.js`.
- Every length an assembly file owns is in the **project unit**: mate
  `.offset(x, y, z)`, `.limits(min, max)`, instance `.translate(...)`.
- Inserted parts are built in their own unit and **scaled into assembly
  space automatically**. Nothing to write; an inch part in an mm project
  simply comes out 25.4× its inch numbers.
- `insert(def, { width: 10 })` overrides are in the **part's** unit,
  whatever the assembly's. The `inch()`/`mm()` helpers do not help here —
  they convert into the *calling* file's unit, which is the assembly's.
- Sub-assemblies in the same project share the project unit; no scaling
  between them.

## Import / export

- `load("bracket")` needs no unit: imports are cached in mm and scaled
  into the loading file's unit (factor 1 for mm files).
- `load("bracket", { unit: 'in' })` is an **assertion** for assets without
  trustworthy metadata (a hand-copied `.brep`, a STEP whose header is
  wrong). It overrides the recorded unit. Omit it otherwise.
- STEP export is physically correct in any document unit.
- STL export is scaled to mm by default (slicer convention); an export
  option keeps document units.
- BRep is written as-is.

## Precision envelope

Kernel tolerances are absolute, so the unit sets the smallest feature the
kernel resolves cleanly. Match the unit to the feature scale: model small
parts in `mm`, not as tiny fractions of a metre; `cm`/`m`/`ft` are for
objects that are naturally that size. When in doubt: `mm`, plus `inch()`
for the odd imperial dimension.

## Authoring checklist

- Reading a drawing in inches? Either `unit('in')` at the top and write
  the drawing's numbers verbatim, or stay in mm and wrap each with
  `inch(...)`. Do not multiply by 25.4 by hand.
- Never put `unit()` in an assembly file or inside a callback.
- Fillet/chamfer/text sizes in a non-mm file: pass explicit values.
