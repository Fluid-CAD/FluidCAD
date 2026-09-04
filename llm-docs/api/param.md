---
id: api/param
title: "param(label, default, type?, options?)"
summary: "Declares a named parameter with a UI control (number, slider, text, select, checkbox, color) and returns its value. In a part file it is a Parameters-panel control; inside part()/assembly() it is the definition's parameter interface that insert(def, { Label: value }) overrides per instance."
tags: [api, part, assembly, parameters]
symbols: [param]
seeAlso: [api/part, api/insert, concepts/assemblies]
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

Where the value comes from:

- **Top level of a part file** — the Parameters panel. Editing a control
  re-renders and writes the new value back as the statement's default.
- **Inside `part()` / `assembly()`** — the definition's parameter interface.
  `insert(def, { Length: 380 })` supplies values per instance; unknown keys
  are warned about; values are read in the **part file's unit**.

Declare parameters at the top of the body, before the geometry that uses
them. Labels are unique within a part.

## Example

```fluid.js
import { part, param, sketch, line, circle, extrude, fillet } from "fluidcad/core";
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

const extrusion = part("Extrusion", () => {
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
    circle([0, 0], bore);
  });
  extrude(length);
});
```

Overriding from an assembly (in a `*.assembly.js` file):

```js
insert(extrusion, { Length: 380, Series: 30 });
```
