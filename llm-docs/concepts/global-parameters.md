---
id: concepts/global-parameters
title: "Project parameters — *.params.js files shared across models"
summary: "A project parameter is a param() exported from the top level of a *.params.js file (project.params.js by convention) and read from any part or assembly through an ordinary import. The file holds only imports and export const declarations, in the project unit; a plain export const is a derived read-only value. Its literal IS the value everywhere: the Global Parameters panel edits the source, an assembly cannot override it per instance. Shared dimensions go here — import them, never copy the number."
tags: [concept, parameters, project, units]
seeAlso: [api/param, api/part, api/insert, concepts/assemblies, concepts/units]
---

# Project parameters

A dimension that several files share — a wall thickness, a bolt size, a
clearance — is declared once in a `*.params.js` file and imported by every
model that reads it. The number is written in one place; every importer
rebuilds when it changes.

```js
// project.params.js
import { param } from "fluidcad/core";

export const wall = param("Wall thickness", 3, "number", { min: 1, max: 10, step: 0.5 });
export const boltSize = param("Bolt", "M4", "select", { options: [{ label: "M3", value: "M3" }, { label: "M4", value: "M4" }] });
export const width = param("Width", 120);
export const innerWidth = width - 2 * wall;   // derived — read-only in the panel
```

```js
// bracket.part.js
import { part, sketch, rect, extrude } from "fluidcad/core";
import { wall, innerWidth } from "./project.params.js";

export const bracket = part("Bracket", () => {
  sketch("xy", () => { rect([0, 0], innerWidth, 40); });
  extrude(wall);
});
```

`wall` is a plain number in the importing file: a sketch guess, a
dimension, an extrude distance, a loop bound.

## The file

The suffix is what FluidCAD keys on: `<name>.params.js`. Several are
allowed; `project.params.js` at the workspace root is the convention and
what the UI creates on first use. The file is **not a model**: it is never
rendered as the scene, and a write to it re-renders the model that is open
(as a dependency) instead. Rules — each a lint error at the statement and a
build error at render:

1. Only top-level statements: imports, `export const x = param(…)`,
   `export const y = <expression>`, comments. No `part()`, `sketch()`,
   geometry, `unit()`, `property()`.
2. Every `param()` is the initializer of an `export const`. An unexported
   or unbound `param()` is unreachable from other files → error ("export
   it"). The exported identifier (`wall`) is what other files import; the
   label (`Wall thickness`) is what the panel shows.
3. Imports are limited to `fluidcad/core`, `fluidcad/units` and other
   `*.params.js` files. Importing a model file is refused (it would make a
   cycle model → params → model).
4. Labels are unique per file; identifiers are valid JS identifiers.
5. No `unit()`: numbers are in the **project unit**.

A plain `export const` without `param()` is a **derived value**: listed
with its expression and evaluated value, read-only in the panel (edit the
expression in the file).

## Units

Numbers in a params file are in the project unit (`"unit"` in
`fluidcad.json`, `mm` by default), like an assembly's. A number read from a
part file whose own `unit()` differs is **not converted** — a `param()`
has no dimension, and a hole count or an angle must not be scaled by 25.4.
Convert a *length* yourself with the `fluidcad/units` helper for the
project unit, and leave counts, angles and ratios alone:

```js
// flange.part.js — an inch part in a millimetre project
import { unit, extrude } from "fluidcad/core";
import { mm } from "fluidcad/units";
import { wall, holes } from "./project.params.js";

unit("in");
extrude(mm(wall));            // a length: 3 mm expressed in this file's inches
// holes: a count, used as is
```

## The value is the literal

A project parameter has no session override and no per-instance override:
the declaration's default literal is the value in every file that imports
it. The Global Parameters panel (the rail button below Code) edits that literal in
source and re-renders the open model; there is no "reset to defaults".
`insert(bracket, { "Wall thickness": 5 })` names no parameter of the part
and warns: *`Wall thickness` is a project parameter — edit it in the
Global Parameters panel, not per instance.* A value that must vary per instance
is a part `param()`; a value that must agree across the project is a
project parameter.

Renaming an identifier rewrites every `import { wall }` specifier and
every read in the importing files; deleting one inlines its literal into
every read (refused when the value would not mean the same where it is
read).

## In expressions

Every expression input offers the project parameters after the file's own
variables (a `G` chip, the value with the project unit — `3 mm`) and
**writes the import** when one is picked. A global whose name the file
already binds (a local `const wall`) is hidden: JavaScript would read the
local. A global imported under an alias is offered as the alias.

## For agents (MCP)

- Read what exists before copying a number: `list_global_params` (every
  params file's rows and `projectUnit`, no model needed) or the
  `globalParams` block of `get_scene_summary` (`{ name, label, value,
  file }`). A value that already exists is imported, never retyped.
- `write_file` / `edit_range` on a `*.params.js` path lint the file
  against the rules above first (refusal code `params-file`,
  `details.diagnostics` lists the rows), then re-render the **open**
  model against the new declarations; `render.state` is `"no-model"`
  when nothing is open and the file is on disk either way.
- Write the models that import the file before editing it when you want
  the render to show the change.
