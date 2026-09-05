# Writing FluidCAD documentation

FluidCAD is a hybrid CAD: you model in the viewport and the source file is
written for you, and you can also write the source by hand. The documentation
reflects that. **Every feature page leads with the UI interaction** — which
button, which dialog fields, what you click in the viewport — shows the
result, and then puts the generated, commented code in a collapsed accordion
under the example. A reader who never opens the accordion still learns the
tool; a reader who writes code by hand gets the exact statements and what each
one means.

This file is the contract for everyone (people and agents) adding pages.

## Structure

```
website/docs/
  introduction.mdx, installation.mdx, user-interface.mdx, cli.mdx
  getting-started/   part-container → basic-sketch → 3d-features → connectors →
                     export → insert-into-assembly → joints → animate-joint
  datums/            axes, planes
  sketching/         introduction; primitives/, compound/, tools/, constraints/{positional,dimensional}
  3d-operations/     introduction, selection-and-filters, extrude, revolve, sweep, loft,
                     shell, fillet, chamfer, wrap, rib, helix
  booleans/          introduction, fuse, common, subtract
  transforms/        introduction, translate, rotate, mirror
  patterns/          copy, repeat
  appearance/        color
  extra/             reusable-objects, units, project-configuration, editor-setup
  import-export/     import, export
  part/              introduction, part, param, connector, expose
  assembly/          introduction, grounded, fastened, slider, revolute, cylindrical, planar, tangent, replicate
  tutorials/         (unchanged)
  api/               (generated — never edit by hand; `npm run generate-api-docs`)
```

- `sidebars.ts` lists the sections in order. Page order inside a section is
  the page's `sidebar_position`; sub-folders carry a `_category_.json`.
- Every section has ONE `_examples/` folder directly under it
  (`docs/sketching/_examples/`), shared by all its sub-pages. Import with the
  right number of `../`.
- Screenshots: `docs/<section>/.../_examples/<name>.js` renders to
  `static/img/docs/<section>/<name>.png`, referenced as
  `/img/docs/<section>/<name>.png`. Hand-made UI screenshots live in
  `static/img/docs/ui/`.
- Links between pages are absolute: `/docs/sketching/tools/offset`. Never link
  to `/docs/guides/...` (gone) or `/docs/getting-started/your-first-model`.

## Page template

```mdx
---
sidebar_position: 3
title: "Extrude"
---

import {ExplainedCode} from '@site/src/components/docs/ExplainedCode';
import {ModeTable} from '@site/src/components/docs/ModeTable';
import extrudeBasic from '!!raw-loader!./_examples/extrude-basic.js';

# Extrude

One sentence: what the feature does and when you reach for it.

## In the viewport

1. With a closed sketch in the file, click **Extrude** on the toolbar.
2. The Extrude dialog opens docked on the right. The **Add / Remove / New**
   tabs choose how the new material meets the model; the **Profile** slot is
   filled by clicking the sketch in the timeline or its wires in the viewport;
   **Distance** takes a number or an expression …
3. Click **Apply**. The timeline gains an Extrude row and the statement is
   written to the file.

![Basic extrude](/img/docs/3d-operations/extrude-basic.png)

<ExplainedCode code={extrudeBasic} fileName="box.part.js" />

## Symmetric

…same shape: what to do in the dialog, the picture, the accordion.
```

Rules:

- The UI walkthrough is written as steps a person performs. Name buttons,
  tabs, slots and toggles exactly as the UI labels them (bold). Do not invent
  UI: if you are not sure a control exists, look it up in `ui/src` (the
  reference below covers most of it) or describe the code form instead.
- Under every example: the screenshot, then `<ExplainedCode>` with the
  example file. The code must carry comments that explain the statements the
  UI produced — that IS the code documentation. Comment the first example on a
  page thoroughly; later variants comment only what is new.
- Keep the "Accessing geometry" reference blocks (`e.endFaces()` …) as plain
  fenced code — they are not examples.
- Prose: short sentences, no marketing adjectives, no "simply". Say what a
  thing does, not what it is "designed to". Numbers go in tables.
- Admonitions (`:::note`, `:::tip`, `:::caution`) for real caveats only.

## Components

- `ExplainedCode` (`@site/src/components/docs/ExplainedCode`):
  `<ExplainedCode code={src} fileName="box.part.js" title="The code behind it" open={false}>optional prose</ExplainedCode>`.
  Strips `// @screenshot` lines itself.
- `ModeTable` (`@site/src/components/docs/ModeTable`): side-by-side results.
  ```mdx
  <ModeTable columns={[
    {title: 'Add', code: 'extrude(20)', image: '/img/docs/3d-operations/extrude-scope-add.png', description: 'Fuses with the solid it touches.'},
    {title: 'New', code: 'extrude(20).new()', image: '…', description: '…'},
    {title: 'Remove', code: 'cut(20)', image: '…', description: '…'},
  ]} />
  ```
- `UiFigure` (`@site/src/components/docs/UiFigure`): screenshot with numbered
  callouts, `markers={[{n: 1, x: 12, y: 8, label: 'Tabs', description: '…'}]}`
  (x/y in percent of the image). Use it for UI screenshots.
- `ViewerEmbed` / `OpenInViewer` (existing): click-to-render viewer for a
  complete single-file model (`code={src}` — the source travels in the URL).
  Use at the top of tutorial pages and under "Full code" — not on every
  example. For multi-file models (assemblies) or a per-step walkthrough, use a
  **published package** instead: `<ViewerEmbed packageId={pkgs["step"].id}
  poster="/img/docs/<section>/<name>.png" alt="…" />`. With a `poster` the
  step's screenshot stands in for the idle viewer and nothing loads until the
  reader presses play, so a page can carry one embed per step. Packages are
  declared in the section's `_examples/viewer-packages.json` (key →
  `{ entry, as?, name }`; `as` renames the entry to the file name the tutorial
  uses, relative imports are packed along) and published with
  `node website/scripts/publish-viewer-packages.mjs <section>` — it packs each
  entry, uploads new ones to the viewer's R2 package store through wrangler
  (needs the `../FluidCAD-Viewer` checkout and a wrangler login), and writes
  the content-derived `id` back into the JSON, which the page imports.
- Docusaurus `<details>` is also fine for any other collapsed content.

## Example files

Every example is a complete runnable file in the section's `_examples/`:

- Imports at the top, one line per module:
  `import { sketch, line, extrude } from 'fluidcad/core';`
  `import { coincident, distance } from 'fluidcad/constraints';`
  `import { face, edge } from 'fluidcad/filters';`
- Name it `<page>-<variant>.js` (`extrude-scope-new.js`, `constraint-tangent-junction.js`).
- Comments explain intent: what the statement does and why it is there
  (`// pin the corner so the whole profile cannot slide`), not what JavaScript
  is. Use `// highlight-next-line` / `// highlight-start` … `// highlight-end`
  to emphasise the lines the page is about.
- Optional first line `// @screenshot …` with any of: `showAxes`, `hideGrid`,
  `view iso-ftr` (any named view: front, top, right, iso-ftr …), `size 1200x800`,
  `aspectRatio 1.5`, `noAutoCrop`, `crop 0,0,100,16` (keep a percent region x,y,w,h after
  auto-crop — for scenes where a far construction point stretches the frame), `delay 8000` (ms to wait for the browser to
  mesh the scene; `text()` examples wait 10 s automatically), `skip`. Do not
  use `waitForInput` — it blocks an unattended run. Axes show automatically
  when the code contains `revolve(`, `mirror(` or `rotate(`. An example that
  fails to compile is reported as FAILED (the previous scene would otherwise
  be captured as a silent duplicate), so every existing example must stay on
  the current API.
- Mode tables (Add / New / Remove, thin in the same three) use one base part
  and change ONLY the mode between the three files, so the pictures compare.
- Assembly examples need their part files next to them. Put the parts in the
  same `_examples/` folder as `<name>.part.js`-style siblings and import them
  relatively (`import { bracket } from './hinge-bracket.part.js'`). The
  screenshot script renders each `_examples/*.js` on its own, so give an
  assembly example `// @screenshot skip` unless it is self-contained, and
  capture its picture by hand (see below).

### Verifying an example

A scratch FluidCAD server is running for this purpose. Write the file into
its workspace through the MCP tool and read the render state back:

```
mcp__FluidCAD__write_file
  workspace: /private/tmp/claude-501/-Users-marwan-projects-FluidCAD/852ede68-edf5-4beb-90df-2f0d8eec7ba8/scratchpad/ws
  path: <section>-<name>.part.js        (or .assembly.js)
  content: <the example>
```

`render.state` must be `rendered`; `build-error` lists the failing feature in
`render.objectErrors`, `compile-error` carries the message. Fix the example
until it renders. Prefix scratch file names with your section so parallel
authors do not overwrite each other, and write an assembly's part files
before the assembly. Multi-file assembly imports resolve relative to the
workspace root, so the part files in the scratch workspace must carry the
same names the assembly imports.

Do not run `generate-screenshots.mjs`, `publish-viewer-packages.mjs` or `npm run build` yourself — both are
run once at the end for the whole site (they need a browser, and concurrent
builds collide). Do not edit `sidebars.ts`, `docusaurus.config.ts`, or
`scripts/generate-screenshots.mjs`.

## UI reference (what exists, by its label)

Verified against `ui/src` at the time of writing. Use these names.

**Top bar** — logo, workspace name, the open files as tabs (right-click a tab:
rename; drag to reorder; **+** = *Open a file* — a quick-open box that opens
an existing file or creates a new one when the name does not exist),
**Import** (STEP), **Export** (menu of solids; in an assembly it leads with
*Whole assembly*), theme toggle. On narrow windows these collapse into one
**Actions** menu.

**Panel rail** (left edge) — latch buttons: **Code editor** (<kbd>Ctrl</kbd>+<kbd>B</kbd>;
docks left and takes width from the scene) and **Feature tree** (the
History/timeline panel; in an assembly the rail calls it **Parts**).

**Timeline / History panel** (part mode) — one row per feature in file order.
Single click a row: rollback preview to that feature. Double-click a row:
places a breakpoint after it and opens the feature's edit dialog. Right-click
a row: **Rename** (edits `.name('…')`), **Edit feature**, **Breakpoint here**
(a `breakpoint()` after the row, so features you add next land there),
**Remove** (deletes the statement; if later features depend on it, a dialog
lists them and deletes the closure on confirm). Sketch rows fold their
constraints behind an *N constraints* toggle row; part rows fold *N
connectors* and *N exposed*. Feature status glyph: check = served from cache,
refresh = recomputed. The panel's **⋯** menu: **Recompute scene** (clears the
cache and rebuilds everything) and **Show execution time**. **Undo / Redo**
sit above it.

**Shapes panel** — one row per solid; eye toggle, **Transparency**, **Export**
(row menu). Clicking a row selects the solid.

**Shape properties** (from a shape row) — **Volume**, **Material** (density
presets) → **Mass**, plus centre of mass; **Calculate** runs it.

**Parameters panel** — one control per `param()` (number, slider, text,
select, checkbox, color); **+** adds a parameter through a dialog (writes the
`param()` statement), reset restores defaults. Values edited here are written
back to the source.

**Measure** — no tool to arm: click a face, edge or vertex (ctrl/shift-click
adds up to 8). A status bar shows the result; expand it for the panel: per
entity *Type / Length / Radius / Diameter / Area*, and for pairs *Min dist /
Max dist / Center dist / Axis dist / Parallel dist / Angle*, plus *Total
length / Total area*. Works the same on assembly instances. Unit menu:
document unit / mm / in / *Same as project*.

**Feature toolbar** (part mode) — **Sketch** (pick a face or plane), the
create tools **Extrude**, **Revolve**, **Sweep**, **Loft**, **Wrap**,
**Helix**, **Rib**, the pick tools **Fillet**, **Chamfer**, **Shell**,
**Offset** (face outline), then **Plane**, **Repeat**, **Copy**, **Mirror**,
**Rotate**, **Boolean** (Fuse / Subtract / Common), and the structure tools
**Part** (appends `part('Part N', () => {})`) and **Connector**. The pick
tools show a small panel with one value (**Radius** / **Distance** /
**Thickness**, defaults 1 / 1 / -2) and take edge or face clicks in the
viewport; right-clicking a pick opens the multi-select menu (tangent chain,
same-type edges, the feature's other buckets such as *Extrude End Edges*,
*Select other*). Every create dialog docks on the right and has **Apply** /
**Cancel**; a translucent ghost previews the result while the dialog is open.
`translate()` and `color()` have no dialog in part mode — they are written in
code (instances in an assembly are moved with the gizmo instead).

Dialog fields:
- **Sketch**: a **Face / Plane** pick slot — the first pick writes the
  `sketch()` statement and enters the sketch. Sketch options: **Section
  view**, **Lock camera**, **Snap to vertices**, **Snap to grid**,
  **Auto-constraints → Infer while drawing** (coincident on snapped vertices,
  horizontal/vertical on near-axis lines; hold <kbd>Ctrl</kbd> to skip one),
  **Show constraints → Dimensional / Positional**. The green **Finish sketch**
  button ends the sketch and offers the follow-up feature (Extrude, …).
- **Extrude**: tabs **Add / Remove / New**; **Profile** slot; direction
  **One direction / Symmetric / Two distances / Up to face** (a picked face,
  *first face* or *last face*); **Distance** (or **Depth** on Remove;
  *Through all* on Remove); **Draft** angle; end **Offset**; **Drill holes**
  toggle; **Thin** toggle with thickness.
- **Revolve**: tabs Add / Remove / New; **Profile**; **Axis** slot (an axis
  or edge picked in 3D, or the X / Y / Z quick buttons); **Angle**; **Thin**.
- **Sweep**: tabs; **Profile**; **Path** (a sketch, a helix, or picked edges).
- **Loft**: tabs; **Sketches — in loft order** (reorderable); **Guides —
  optional, up to 2**; start / end condition (none / normal / tangent) with a
  magnitude; **Thin**.
- **Rib**: **Spine sketch**, thickness, parallel / extend / draft, scope.
- **Wrap**: sketch, **Cylindrical face** slot, thickness, Add / Remove / New.
- **Helix**: **From axis** / **From face** source, **Radius**, **Pitch**,
  **Turns**, height, **end radius**, **start offset / end offset**.
- **Plane**: type **Offset / Mid plane / From edge**, **Base** slot (a face,
  an origin plane quad in the viewport, or a plane row in the timeline),
  **Distance**, edge position 0–1, per-axis rotation.
- **Axis** slots (revolve, repeat, copy, rotate): an axis or edge picked in 3D,
  or the X / Y / Z quick buttons; `axis()` statements with transform options are code-only.
- **Mirror** (3D): tabs Add / Remove / New; **Solids** slot; **Plane** slot.
- **Copy / Repeat**: kind (linear / circular / mirror), **Axis** slots,
  count, offset / length / angle, centered, skip.
- **Rotate**: tabs **Move** (turn in place) / **Copy** (keep originals, add
  turned copies); **Solids** slot; **Axis** slot; **Angle**.
- **Boolean**: **Fuse / Subtract / Common**, **Target** and **Tool** solids.
- **Connector**: **Source** slot (hover faces/edges to see anchor candidates
  — face centre, edge centre / start / end — as a translucent frame; click to
  take one), **Name**, frame-local **Offset** x/y/z, and a rotation stepper
  (90° about the frame's own Z per click).

**Sketch toolbar** (while a sketch is open) — **Line**, **Polyline**,
**Bezier**, **Circle**, **Polygon** (menu: *Circumscribed* / *Inscribed*),
**Rectangle** (menu: *Rounded*, *Centered*), **3-Point Arc**, **Center Arc**,
**Slot**, **Text**, **Fillet**, **Offset**, **Project**, **Copy**, **Rotate**,
and a **Guide** latch (geometry drawn while it is on gets `.guide()`).
Every tool's anchor point shows an **X / Y** coordinate pill: type a value,
<kbd>Tab</kbd> between fields, expressions and `param()` names allowed;
double-click a point to reposition it. <kbd>Esc</kbd> leaves the tool.
Dragging unconstrained geometry re-solves live.

**Constraint toolbar** (appears under the sketch toolbar once you select
sketch entities) — **Coincident**, **Horizontal**, **Vertical**, **Parallel**,
**Perpendicular**, **Tangent**, **Equal**, **Concentric**, **Collinear**,
**Midpoint**, **Symmetric**, **Fix**, **Dimension**, **Angle**. Buttons enable
according to what is selected (e.g. Equal needs two or more lines or two or
more circles/arcs). Dimension labels: double-click to edit the value in
place.

**Sketch colours** — green = fully constrained, default = free (draggable),
red = conflicting. The status readout gives the remaining DOF and names
redundant/conflicting statements.

**Assembly toolbar** (in a `.assembly.js` file) — **Insert** (a two-step
wizard: a grid of every part / sub-assembly in the workspace with thumbnails,
click a tile to queue an instance, then one parameter page per queued
instance that declares `param()`s; *Insert N* commits them all), the mates
**Fastened**, **Revolute**, **Slider**, **Cylindrical**, **Planar**,
**Tangent**, then **Replicate** and **Connector** (an assembly-level
`connector('name', [x, y, z])` frame). Instances are moved with the transform
gizmo (drag arrows / rings); the pose is written back as
`.translate()` / `.rotate()` on the `insert()` statement.

**Mate dialog** — **Type** dropdown, two connector pick slots (click connector
gizmos in the viewport; all part connectors are shown while picking; the
pen button on a chip edits that connector's name/offset/rotation), **Flip**,
**Rotate** (degrees about the joint Z), **Offset** (x/y/z in the driving
connector's frame; slider / cylindrical / planar accept Z only) and
**Limits** (slider: travel in document units; revolute: degrees). The mate
is solved live as a preview while the dialog is open.

**Assembly rail** — **Parts** (one row per instance; eye toggle; menu: Show
in source, Toggle grounded, Rename, Delete; sub-assemblies group under a
header), **Connectors** (assembly-level connectors), **Joints** (one row per
`mate()`; click highlights both connectors; right-click a revolute/slider
row → **Animate…**).

**Animate bar** — bottom-centre chips: **Start**, **End**, **Steps**,
**Playback** (*Single / Loop / Reciprocate*), then **Play / Pause**, **Stop**
(returns the part to where it was), **Close**. Defaults: revolute 0° → 360°,
slider current → +10 units; authored `.limits()` seed Start/End.

**Viewport chrome** — grid toggle, perspective / orthographic, fit to view,
unit chip (bottom right), scale bar. Breakpoint indicator shows while a
`breakpoint()` is active.

**Editors** — the in-page code editor (Monaco, engine-typed completion),
VS Code extension (**Show FluidCAD Scene**; gutter click inserts
`breakpoint()`), Neovim plugin (`:FluidCadOpenBrowser`,
`:FluidCadToggleBreakpoint`).

## API facts worth getting right

- File kinds: `.part.js` (parts), `.assembly.js` (assemblies), `.fluid.js`
  (legacy, still opens). `part()` is optional in a `.part.js` file — a file
  with bare statements renders — but only an exported `part()` definition can
  be inserted into an assembly.
- `part(name, () => {...})` returns a lazy definition; `param()` inside it is
  the part's parameter interface (`insert(def, { Length: 380 })`);
  `connector('name', geometry, { xDirection? })` registers a mate frame (only
  directly in the part body); `expose('name', sceneObject)` publishes geometry
  read back as `def.features.name` (source) / `instance.features.name`
  (bound to an instance). `.rotate('z', 90)` / `.offset(x, y, z)` chain on a
  connector.
- Assembly: `insert(def, overrides?)` returns an `Instance` (part) or
  `Occurrence` (sub-assembly); chain `.translate(x, y, z)`, `.rotate(axis, deg)`,
  `.grounded()`, `.name('…')`. `mate(type, a, b)` with type one of
  `fastened`, `revolute`, `slider`, `cylindrical`, `planar`, `tangent`; sides
  are `instance.connectors.name` (tangent: `instance.features.name`); chain
  `.flip()`, `.rotate(deg)`, `.offset(x, y, z)` (Z only for slider /
  cylindrical / planar), `.limits(min, max)` (slider / revolute),
  `.noPropagate()` (tangent). `assembly(name, () => {...})` defines a
  sub-assembly whose return value is `occurrence.parts`. `replicate(seed,
  targets, rows)` copies a mated instance onto new targets. Assembly-level
  `connector('name', [x, y, z])` is a free frame. Units: assembly lengths are the project
  unit; parts are scaled in; overrides are in the part's unit.
- Sketches: every sketch is solved; geometry statements are guesses,
  constraints pin them. Datums `origin()`, `xAxis()`, `yAxis()` from
  `fluidcad/core`. Constraints from `fluidcad/constraints`: `coincident,
  horizontal, vertical, parallel, perpendicular, tangent, equal, concentric,
  collinear, midpoint, symmetric, fix, distance, angle, radius, diameter`.
  `text()` glyphs cannot be constraint targets — only the text's anchor
  (`t.anchor()`), and only when the text does not follow a path.
- Fusion scope on extrude / revolve / sweep / loft / rib / wrap: `.add()`
  (default), `.new()`, `.remove()`, `.scope(...solids)`; `cut()` is
  `extrude().remove()`. `.thin(d)` / `.thin(d1, d2)` on extrude, revolve,
  sweep, loft.
