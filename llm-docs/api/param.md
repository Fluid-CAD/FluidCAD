---
id: api/param
title: "param(label, default, type?, options?)"
summary: "Declares a named parameter with a UI control (number, slider, text, select, checkbox, color) and returns its value. Valid inside a part()/assembly() body — a Parameters-panel control under its part when the file is open, and the definition's parameter interface that insert(def, { Label: value }) overrides per instance — or as an export const at the top level of a *.params.js file, where it is a project parameter every model imports. Anywhere else at a file's top level it throws."
tags: [api, part, assembly, parameters]
symbols: [param]
seeAlso: [api/part, api/insert, concepts/assemblies, concepts/global-parameters]
---

# param

Imported from `fluidcad/core`.

```ts
param(label: string, defaultValue: T): T
param(label: string, defaultValue: T, type: ParamType, options?: ParamOptions): T
param(label: string, defaultValue: (string | number)[], type: 'select', options: { options, multi: true }): (string | number)[]
```

Returns the **resolved value** — a plain number, string, boolean or array —
so the rest of the file uses it like any variable. The `label` is the key:
what the Parameters panel shows and what an assembly override names.

| `type` | default | options |
|--------|---------|---------|
| `'number'` | number | `min`, `max`, `step` |
| `'slider'` | number | `min`, `max`, `step` |
| `'text'` | string | — |
| `'select'` | an option `value` (array with `multi: true`) | `options: [{ label, value }]`, `multi`, `multiControlType: 'select' \| 'checkboxes' \| 'chips'` |
| `'checkbox'` | boolean | — |
| `'color'` | CSS colour string | — |

Every type also takes `group` (parameters with the same group fold together)
and `description` (help text). Without a `type` the control follows the
default: boolean → checkbox, number → number field, string → text field.

`param()` is valid inside a `part()` or `assembly()` body, or as the
initializer of an `export const` at the top level of a `*.params.js` file.
At the top level of a part or assembly file it throws (`param('Width')
must be declared inside a part() body — move it to the top of the part's
callback, or export it from a *.params.js file to share it across the
project`): a model file has no parameters of its own. Where the value
comes from:

- **The defining file, open in the editor** — the Parameters panel, which
  lists the parameters of one part at a time (the part selected in the
  History panel by default).
  Editing a control re-renders and writes the new value back as the
  statement's default.
- **Inserted into an assembly** — the definition's parameter interface.
  `insert(def, { Length: 380 })` supplies values per instance; unknown keys
  are warned about; values are read in the **part file's unit**.
- **Exported from a `*.params.js` file** — a project parameter
  ([[concepts/global-parameters]]). Its literal is the value in every
  file that imports it: the project Parameters panel edits the source,
  there is no session override, and an `insert()` override naming it
  warns instead of applying. Numbers are in the project unit.

Declare parameters at the top of the body, before the geometry that uses
them. Labels are unique within a part (and within a params file).

## Shared across files

A dimension several models read goes in `project.params.js`, exported,
and is imported — never copied as a number:

```js
// project.params.js
import { param } from "fluidcad/core";

export const wall = param("Wall thickness", 3, "number", { min: 1, max: 10, step: 0.5 });
export const width = param("Width", 120);
export const innerWidth = width - 2 * wall;   // derived, read-only in the panel
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

The params file holds only imports (`fluidcad/core`, `fluidcad/units`,
other `*.params.js`) and `export const` declarations — no geometry, no
`unit()`, no `property()` — and is never rendered as a model.

## Example

```fluid.js
import { part, param, sketch, line, circle, extrude, fillet, origin } from "fluidcad/core";
import { coincident, diameter, distance, fix, horizontal, vertical } from "fluidcad/constraints";

export const extrusion = part("Extrusion", () => {
  const size = param("Series", 20, "select", {
    options: [
      { label: "20 × 20", value: 20 },
      { label: "30 × 30", value: 30 },
      { label: "40 × 40", value: 40 },
    ],
    group: "Profile",
  });
  const bore = param("Bore", 4.2, "slider", { min: 3, max: 8, step: 0.1, group: "Profile" });
  const length = param("Length", 150, "number", { min: 20, max: 2000, step: 10 });
  const rounded = param("Rounded corners", true, "checkbox");

  sketch("xy", () => {
    const b = line([-size / 2, -size / 2], [size / 2, -size / 2]);
    const r = line([size / 2, -size / 2], [size / 2, size / 2]);
    const t = line([size / 2, size / 2], [-size / 2, size / 2]);
    const l = line([-size / 2, size / 2], [-size / 2, -size / 2]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    horizontal(t);
    vertical(r);
    vertical(l);
    fix(b.start(), [-size / 2, -size / 2]);
    distance(b.start(), b.end(), size);
    distance(r.start(), r.end(), size);
    if (rounded) {
      fillet(2, b, r, t, l);
    }
    const hole = circle([0, 0], bore);
    coincident(hole.center(), origin());
    diameter(hole, bore);
  });
  extrude(length);
});
```

Overriding from an assembly (in a `*.assembly.js` file):

```js
insert(extrusion, { Length: 380, Series: 30 });
```
