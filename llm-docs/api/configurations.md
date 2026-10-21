---
id: api/configurations
title: "configurations(rows)"
summary: "Declares the named configurations of a part or assembly — a table of value sets for the body's own param() interface, { Name: { Label: value } } — as the FIRST statement of the body, and returns the name of the row being built ('Default' = the param() literals). Rows are sparse: a label a row leaves out keeps its literal. A parent inserts a row by name, insert(def, 'Name') or insert(def, 'Name', { Label: value }); never copy a row's numbers into an override object."
tags: [api, assembly, part, parameters, configurations]
symbols: [configurations]
seeAlso: [api/param, api/insert, api/assembly, api/part, concepts/configurations, concepts/assemblies]
---

# configurations

Imported from `fluidcad/core`. Only inside a `part()` or `assembly()` body.

```ts
configurations(rows: Record<string, Record<string, value>>): string
```

A configuration is a named set of values for the body's `param()` calls.
The `param()` declarations are the schema (label, default, control,
bounds) and are written once; each row holds only the labels it changes.
The `'Default'` configuration is the `param()` literals and is always
present.

```js
import { part, param, configurations } from "fluidcad/core";

export const bracket = part("Bracket", () => {
  // First statement of the body, before any param().
  const configuration = configurations({
    M8:  { Screw: "M8", Width: 50, Thickness: 5 },
    M10: { Screw: "M10", Width: 60, Thickness: 6, Gusset: true },
  });
  // A select cell is the option's value, so hole(screw, …) reads it as is.
  const screw = param("Screw", "M6", "select", {
    options: [
      { label: "M6", value: "M6" },
      { label: "M8", value: "M8" },
      { label: "M10", value: "M10" },
    ],
  });
  const width = param("Width", 40, "number", { min: 30, max: 120, step: 5 });
  const thickness = param("Thickness", 4);
  const gusset = param("Gusset", false, "checkbox");
  // … the L profile extruded `width`, hole(screw, …) in each leg,
  // if (gusset) { … } for the rib only the M10 row turns on.
});
```

The same table in an assembly body:

```js
import { assembly, insert, param, configurations } from "fluidcad/core";
import { rail } from "./rail.part.js";
import { lid } from "./lid.part.js";

export const frame = assembly("frame", () => {
  // First statement of the body, before any param().
  const configuration = configurations({
    Compact: { Width: 500, Depth: 600, Lid: false },
    Wide:    { Width: 1200 },
  });

  const width = param("Width", 700, "number", { min: 400, max: 1500, step: 10 });
  const depth = param("Depth", 800);
  const withLid = param("Lid", true, "checkbox");

  insert(rail, { Length: depth }).grounded();
  insert(rail, { Length: depth }).translate(width, 0, 0);
  if (withLid) {
    insert(lid, { Width: width, Depth: depth }).translate(0, 0, 40);
  }
  // A parameter only one row has: declared only while that row is built.
  if (configuration === "Wide") {
    const braces = param("Brace count", 3);
    // …
  }
});
```

| | |
|---|---|
| argument | `{ RowName: { Label: value, … }, … }` — a plain object of plain objects. Row names are display names (spaces allowed, quote the key), unique, non-empty, never `'Default'`. Cell values are what a `param()` can produce: number, string, boolean, or an array of numbers/strings (a multi select) — the same shape as an `insert()` override. Literals or expressions. |
| returns | the active row's name, or `'Default'` when the literals are being built |

Resolution of a `param()` in a body with a table, highest first:

1. the `insert()` override object (or a session override: a read-only viewer's panel tweak),
2. the active row's cell, coerced to the literal's type,
3. the `param()` literal.

## Which row is built

- **The defining file, rendered as the model**: the row chosen in the
  Parameters panel's configuration dropdown (or `select_configuration`
  over MCP, `?configuration=Name` on a viewer URL). The choice is session
  state — it is never written into the source — and is remembered per
  file in `.fluidcad/editor-state.json`. A remembered name the table no
  longer declares renders Default with a warning.
- **Several bodies in one file** (two `part()` calls, or a part built in
  an assembly body): row names are file-wide — one active name for the
  file, the dropdown lists the union — but each body applies only its own
  table's row. A body whose table lacks the name, or that has no table,
  builds its literals; a name no table declares warns once at the end of
  the render. Two parts' same label are two parameters; a row's cell in
  part A never sets part B's (part names are unique within a file). The
  panel writes each part's cells into that part's table, and the Manage
  grid groups columns by part (paste titles `Part · Label` for a shared
  label).
- **From a parent**: `insert(def, 'Wide')` builds that row for that
  instance; `insert(def, 'Wide', { Depth: 1000 })` layers overrides on top
  of the row. `insert(def, 'Default')` is the same as `insert(def)`. See
  [[api/insert]].

## Rules (build errors at the statement)

- Called outside a `part()` / `assembly()` body: *"configurations() must be
  called inside a part() or assembly() body"*. A `*.params.js` file has no
  body and cannot declare a table.
- Called after a `param()` of the same body: *"declare configurations()
  before the body's first param()"*.
- A second call in the same body: *"merge the rows into the first
  configurations() call"*.
- A row named `'Default'`, an empty row name, a row that is not a plain
  object, or a cell that is not a param value.
- From a parent, a name the table does not declare throws on the
  `insert()` statement, listing the declared names.

Warnings (not errors): a row cell whose label no `param()` of the build
read (a renamed parameter, or one declared only in a branch the row does
not take), and a cell naming a project parameter (`*.params.js`) — a
project parameter's value is its literal, never set per row.
`insert(def, 'Name')` on a definition with no table warns and builds the
literals.

Numbers in a row are in the **defining file's unit**, like an `insert()`
override; nothing is converted.

## Parent picks a child's configuration

A parent configuration that should use a particular child configuration
declares a `select` parameter whose values are the child's row names, and
passes it as the insert's name. The parent's own rows then set that
parameter:

```js
import { assembly, insert, param, configurations } from "fluidcad/core";
import { frame } from "./frame.assembly.js";

export const machine = assembly("machine", () => {
  configurations({
    Small: { Frame: "Compact" },
    Large: { Frame: "Wide" },
  });
  const frameChoice = param("Frame", "Default", "select", {
    options: [
      { label: "Default", value: "Default" },
      { label: "Compact", value: "Compact" },
      { label: "Wide", value: "Wide" },
    ],
  });
  insert(frame, frameChoice).grounded();
});
```

## Export

STEP names of an instance or sub-assembly inserted with a configuration
name carry it: `frame (Wide)`. `fluidcad export step --configuration Wide`
exports one row; `--all-configurations` writes `<model>.step` for Default
and `<model>-<Row>.step` per row (row names made file-safe), and writes
nothing if any row fails. The Export dialog of a part names its files
after the file: `bracket.step`, `bracket-M8.step`,
`bracket-configurations.zip` (all rows or no zip).

For a part file the default selection is **every solid the chosen row
builds** — desktop File ▸ Export…, the CLI without `--shapes`, and
`POST /api/export` with `shapeIds: "all"` — so a row that adds or drops a
body exports exactly its own bodies. Listed shape ids (the top bar pick,
`--shapes`, MCP `export`'s `shapeIds`) name solids of the row on screen;
each is matched into the exported row by lineage, and one the row does not
build fails with HTTP 400 and `missing: [{ shapeId, label }]` instead of
exporting another body. MCP `export`,
`screenshot`, `screenshot_multi`, `recompute` and `pack_model` take
`configuration`. See [[concepts/configurations]].
