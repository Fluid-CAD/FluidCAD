---
id: concepts/configurations
title: "Configurations — named value sets for a part's or assembly's parameters"
summary: "A configuration is a named row of values for the param() interface of a part or assembly, declared with configurations({ Name: { Label: value } }) as the first statement of the body. The param() calls are the schema, written once; rows are sparse; 'Default' is the literals. Which row the open file shows is session state (the Parameters panel dropdown, select_configuration), never source. In a file with several parts, row names are file-wide and each part applies its own table's row. A parent inserts a row by name — insert(def, 'Wide') — and export, screenshot and pack take a configuration. Anything a configuration 'does' (which parts are inserted, a mate offset) is ordinary code reading the parameter values."
tags: [concept, assembly, part, parameters, configurations]
seeAlso: [api/configurations, api/param, api/insert, concepts/assemblies, concepts/global-parameters, concepts/units]
---

# Configurations

A model that comes in a few known variants — a compact and a wide frame, an
M6 and an M8 bracket, a 2:1 and a 3:1 gearbox — keeps them as
**configurations**: named sets of values for its own `param()` calls, in a
table at the top of the body.

```js
// bracket.part.js
import { part, param, configurations } from "fluidcad/core";

export const bracket = part("Bracket", () => {
  const configuration = configurations({
    M8:  { Screw: "M8", Width: 50, Thickness: 5 },
    M10: { Screw: "M10", Width: 60, Thickness: 6, Gusset: true },
  });
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
  // … geometry reads width / thickness, hole(screw, …), if (gusset) { … }
});
```

```js
// frame.assembly.js
import { assembly, insert, param, configurations } from "fluidcad/core";
import { rail } from "./rail.part.js";

export const frame = assembly("frame", () => {
  const configuration = configurations({
    Compact: { Width: 500, Depth: 600 },
    Wide:    { Width: 1200 },
  });
  const width = param("Width", 700, "number", { min: 400, max: 1500, step: 10 });
  const depth = param("Depth", 800);

  insert(rail, { Length: depth }).grounded();
  insert(rail, { Length: depth }).translate(width, 0, 0);
});
```

```js
// machine.assembly.js — a parent picks a row by name
import { frame } from "./frame.assembly.js";
const base = insert(frame, "Wide").grounded();
const deep = insert(frame, "Wide", { Depth: 1000 }).translate(0, 900, 0);
```

## The model

- **Schema once, rows sparse.** The `param()` declarations carry the label,
  default, control and bounds. A row holds only the labels it changes; a
  label it leaves out keeps the literal.
- **`Default` is the literals**, always present, never a row name.
- **Nothing but parameter values is configurable.** Suppressing a part,
  choosing a child's configuration, a mate offset, a colour, an instance
  count: each is code downstream of a parameter (`if (withLid) insert(lid)`,
  `.offset(0, 0, gap)`). A parameter only one row needs is declared under
  `if (configuration === "Wide") { … }` — the return value of
  `configurations()` is the active row's name.
- **Resolution order** for a `param()`: session tweak or insert override →
  the active row's cell → the literal.
- **Units**: cells are in the defining file's unit, like `insert()`
  overrides.
- **Project parameters** (`*.params.js`) cannot be set by a row; a cell
  naming one warns and is ignored. See [[concepts/global-parameters]].
- One table per body, before the body's first `param()`, in a `part()` or
  an `assembly()` body alike. The Parameters panel edits it in both
  workspaces.

## Several parts in one file

- **Rows are file-wide.** The file renders one active name; the dropdown
  lists the union of every table's row names. Each body applies its OWN
  table's row for that name; a body whose table lacks the name (or that has
  no table) builds its literals. A name no table declares renders Default
  with one warning listing the declared names.
- **Cells are per part.** Two parts declaring `Width` have two separate
  parameters; a row sets each in its own part's table, never across parts.
- **Panel writes:** Add / Save put each part's changed values into that
  part's own table (created first in that body); a part the row changes
  nothing in gets no entry. A row with nothing changed goes into the
  **Add to** part. Rename / Delete act on every table holding the row; a
  table a delete empties is removed (the import goes with the last one).
- **Manage grid:** columns grouped under a header per part. A pasted header
  names a shared label as `Part · Label` (`Part / Label`, `Part: Label`,
  `Part.Label`); a bare label two parts share refuses the paste.
- A part's table, parameters and panel values go by the part's name.
  Part names are unique within a file (a second `part()` of a name is a
  build error and never runs), so every table belongs to exactly one part.
  See [[api/part]].

## The active row is session state

Which row the open file renders is chosen in the Parameters panel's
configuration dropdown (the band under the panel header, in the part and
the assembly workspace alike) (or `select_configuration` / `?configuration=`
on a share link) and remembered per file in `.fluidcad/editor-state.json`.
Switching never edits the source. Two tabs or two users can show two rows.

The panel layers on top of the row exactly as it does on Default: a
control change is a session tweak (the band shows **● modified**), the
header's ↺ (*Revert changes*) drops the tweaks, and the band's ⋮ menu
writes source:

| action | writes |
|--------|--------|
| **Add configuration…** / **Save as…** | a new row holding every value on screen that differs from its literal (the active row's cells plus the tweaks); creates the `configurations({…})` statement first in the body and its import when the file has none; the new row becomes active |
| **Save** | the tweaked labels into the active row (cells added or rewritten as literals); disabled on Default and when nothing is modified |
| **Rename…** / **Delete** | the row's key / the row; deleting the last row removes the statement (or leaves `configurations({})` when the body reads its result) |
| **Manage…** | the whole table in a grid — rows × parameters, blank cells inherit, a spreadsheet range pastes in (matched by header labels); one rewrite on **Apply** |

Switching rows with tweaks pending asks **Save / Discard / Cancel**
(from Default: Discard / Cancel). Renaming a `param()` label through the
pencil renames the key in every row; deleting a `param()` drops its cells.

## Inserting a configuration

The Insert dialog shows a **Configuration** select above the form of a
part or sub-assembly that declares a table; picking a row refills the form
from it, and only values changed after that go into the override object:
`insert(frame, "Wide")`, `insert(frame, "Wide", { Depth: 1000 })`. The
Edit parameters dialog has the same select; changing it rewrites only the
name argument (Default removes it) and keeps the override object. The
Parts panel subtitle shows `frame · Wide`. Two inserts of one row share a
build; `insert(frame, "Wide")` and `insert(frame, { Width: 1200 })` build
separately even when the values agree.

A parent configuration that picks a child configuration: a `select`
parameter whose values are the child's row names, passed as the name —
`insert(gantry, gantryChoice)` — set by the parent's own rows.

## Export and agents

- STEP: an instance or sub-assembly inserted with a configuration is named
  `frame (Wide)`.
- Export of a part file (viewport Export dialog, CLI): the **Configuration**
  select / flags pick the row; files are named after the file —
  `bracket.step`, `bracket-M8.step`, `bracket-configurations.zip` from the
  dialog. The default selection (desktop File ▸ Export…, CLI without
  `--shapes`, `POST /api/export` with `shapeIds: "all"`) is **every solid
  the chosen row builds**, so a row that adds or drops a body exports its
  own bodies. Listed solids (top bar pick, `--shapes`, MCP `export`
  `shapeIds`) are matched into the row by lineage; one the row does not
  build is refused (HTTP 400 with `missing: [{ shapeId, label }]`), never
  swapped for another body.
- All configurations is all or nothing: the dialog delivers no zip and the
  CLI writes no file when any row fails.
- CLI: `fluidcad export step|stl|png --configuration Wide`;
  `fluidcad export step|stl --all-configurations` → `<model>.step` for
  Default and `<model>-<Row>.step` per row. An export of a row other than
  the one on screen is rendered on the side and places parts at their
  statement poses (the viewer solves mates for the row on screen only).
- MCP: `get_scene_summary().configurations` is `{ active, names, rows,
  modified }`. `select_configuration(name)` switches the session like the
  dropdown. `export`, `screenshot`, `screenshot_multi`, `recompute` and
  `pack_model` take `configuration`; export renders that row for the one
  call, a screenshot switches the viewer for the capture and switches back.
- A named variant is a row, not a copy: insert it by name, never repeat
  its numbers in an override object.
